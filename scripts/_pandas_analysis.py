"""Dataset-scoped, keyset-paginated Pandas analysis worker.

The worker receives only a dataset id. It opens PostgreSQL directly and
processes bounded pages so the Node API never has to materialize the dataset.
"""

import json
import os
import sys
from collections import Counter
from datetime import datetime

import pandas as pd
import psycopg
from psycopg.conninfo import conninfo_to_dict


PAGE_SIZE = 1000
QUERY_TIMEOUT_MS = max(1_000, int(os.environ.get("PYTHON_DATABASE_QUERY_TIMEOUT", "60000")))


def database_url():
    value = (
        os.environ.get("PYTHON_DATABASE_URL")
        or os.environ.get("DATABASE_DIRECT_URL")
        or os.environ.get("DATABASE_URL")
        or ""
    ).strip()
    if not value:
        raise RuntimeError("DATABASE_UNAVAILABLE: Python database URL is not configured.")
    return value


def safe_database_error(error):
    message = str(error)
    connection_string = database_url()
    if connection_string:
        message = message.replace(connection_string, "[REDACTED]")
        connection_info = conninfo_to_dict(connection_string)
        for secret in (connection_info.get("password"), connection_info.get("user")):
            if secret:
                message = message.replace(secret, "[REDACTED]")
    sqlstate = getattr(error, "sqlstate", None) or "none"
    return (
        f"DATABASE_UNAVAILABLE: Python worker database operation failed "
        f"({type(error).__name__}, SQLSTATE {sqlstate}): {message}"
    )


def analyze(dataset_id):
    if not dataset_id or not str(dataset_id).isdigit():
        raise ValueError("A numeric dataset_id is required.")

    missing = Counter()
    country_counts = Counter()
    product_counts = Counter()
    numeric = {
        "quantity": {"validCount": 0, "min": None, "max": None, "sum": 0.0},
        "value_amount": {"validCount": 0, "min": None, "max": None, "sum": 0.0},
    }
    first_date = None
    last_date = None
    processed = 0
    last_id = 0
    columns = [
        "id", "company_name", "product_name", "category", "role", "country",
        "quantity", "value_amount", "currency", "transaction_date",
    ]
    select_sql = """
        SELECT id, company_name, product_name, category, role, country,
               quantity, value_amount, currency, transaction_date
        FROM normalized_records
        WHERE dataset_id = %s AND id > %s
        ORDER BY id
        LIMIT %s
    """

    try:
        with psycopg.connect(
            database_url(),
            connect_timeout=10,
            application_name="tradeintel-pandas-analysis",
        ) as connection:
            while True:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT set_config('statement_timeout', %s, true)",
                        (str(QUERY_TIMEOUT_MS),),
                    )
                    cursor.execute(select_sql, (int(dataset_id), last_id, PAGE_SIZE))
                    fetched = cursor.fetchall()
                if not fetched:
                    break

                frame = pd.DataFrame.from_records(fetched, columns=columns)
                last_id = int(frame.iloc[-1]["id"])
                page_rows = len(frame.index)
                processed += page_rows
                missing.update({
                    str(column): int(count)
                    for column, count in frame.drop(columns=["id"]).isna().sum().items()
                    if count
                })

                for column, counter in (("country", country_counts), ("product_name", product_counts)):
                    values = frame[column].dropna().astype(str).str.strip()
                    counter.update(values[values != ""].tolist())

                for column, summary in numeric.items():
                    values = pd.to_numeric(frame[column], errors="coerce").dropna()
                    if values.empty:
                        continue
                    summary["validCount"] += int(values.count())
                    page_min = float(values.min())
                    page_max = float(values.max())
                    summary["min"] = page_min if summary["min"] is None else min(summary["min"], page_min)
                    summary["max"] = page_max if summary["max"] is None else max(summary["max"], page_max)
                    summary["sum"] += float(values.sum())

                dates = pd.to_datetime(frame["transaction_date"], errors="coerce", utc=True).dropna()
                if not dates.empty:
                    page_first = dates.min().to_pydatetime()
                    page_last = dates.max().to_pydatetime()
                    first_date = page_first if first_date is None else min(first_date, page_first)
                    last_date = page_last if last_date is None else max(last_date, page_last)

                connection.commit()

    except psycopg.OperationalError as error:
        raise RuntimeError(safe_database_error(error)) from error
    except psycopg.errors.QueryCanceled as error:
        raise TimeoutError("DATABASE_TIMEOUT: Python dataset page exceeded the query timeout.") from error
    except psycopg.errors.UndefinedTable as error:
        raise RuntimeError("DATABASE_SCHEMA_ERROR: normalized_records is missing from the configured database.") from error
    except psycopg.errors.UndefinedColumn as error:
        raise RuntimeError("DATABASE_SCHEMA_ERROR: Python query columns do not match the database schema.") from error

    if processed == 0:
        raise ValueError(f"Dataset {dataset_id} has no persisted normalized records.")

    return {
        "recordsProcessed": processed,
        "columnsReceived": columns[1:],
        "missingValues": dict(missing),
        "countryCounts": dict(country_counts.most_common(20)),
        "productCounts": dict(product_counts.most_common(20)),
        "numericSummary": {
            key: {**summary, "sum": float(summary["sum"])}
            for key, summary in numeric.items()
            if summary["validCount"]
        },
        "dateRange": {
            "first": first_date.isoformat() if first_date else None,
            "last": last_date.isoformat() if last_date else None,
        },
        "datasetId": int(dataset_id),
        "source": "PostgreSQL keyset pages analyzed with Pandas",
    }


try:
    print(json.dumps(analyze(sys.argv[1] if len(sys.argv) > 1 else None), allow_nan=False))
except Exception as error:  # The parent converts this explicit worker failure to a pipeline stage state.
    print(json.dumps({
        "error": str(error),
        "errorType": type(error).__name__,
        "code": getattr(error, "sqlstate", None) or (
            "DATABASE_TIMEOUT" if isinstance(error, TimeoutError) else
            "DATABASE_UNAVAILABLE" if isinstance(error, psycopg.OperationalError) else
            "PYTHON_ANALYSIS_FAILED"
        ),
    }), file=sys.stderr)
    sys.exit(1)

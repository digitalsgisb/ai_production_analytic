"""Langflow SQL tool for Sugi Bobot.

This component returns complete JSON records instead of Langflow's DataFrame
preview, which can hide middle columns behind an ellipsis.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any
from uuid import UUID

from langchain_community.utilities import SQLDatabase
from sqlalchemy.exc import SQLAlchemyError

from lfx.custom.custom_component.component_with_cache import ComponentWithCache
from lfx.io import IntInput, MessageTextInput, MultilineInput, Output
from lfx.schema.message import Message
from lfx.services.cache.utils import CacheMiss


APPROVED_RELATIONS = frozenset(
    {
        "analytics_v2.daily_line_summary",
        "analytics_v2.shift_summary",
        "analytics_v2.hourly_output",
        "analytics_v2.downtime_events",
        "analytics_v2.downtime_summary",
        "analytics_v2.reject_events",
        "analytics_v2.count_adjustments",
        "analytics_v2.data_quality_issues",
        "analytics_v2.shift_end_events",
        "analytics_v2.model_performance",
    }
)

FORBIDDEN_WORDS = re.compile(
    r"\b(?:insert|update|delete|merge|create|alter|drop|truncate|grant|"
    r"revoke|copy|call|do|execute|prepare|deallocate|vacuum|analyze|"
    r"refresh|comment|set|reset|listen|notify|load)\b",
    re.IGNORECASE,
)
FORBIDDEN_OBJECTS = re.compile(
    r"\b(?:information_schema|pg_catalog|ingest|assistant)\s*\.",
    re.IGNORECASE,
)
FORBIDDEN_FUNCTIONS = re.compile(
    r"\b(?:pg_sleep|pg_read_file|pg_read_binary_file|pg_ls_dir|"
    r"dblink|lo_import|lo_export|current_setting)\s*\(",
    re.IGNORECASE,
)
RELATION_REFERENCE = re.compile(
    r"\b(?:from|join)\s+((?:\"?[a-zA-Z_][\w$]*\"?\.)"
    r"\"?[a-zA-Z_][\w$]*\"?)",
    re.IGNORECASE,
)
LINE_COMMENT = re.compile(r"--[^\r\n]*")
BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)

SQL_DATABASE_ENGINE_ARGS = {
    "pool_pre_ping": True,
    "connect_args": {
        "options": "-c default_transaction_read_only=on -c statement_timeout=15000"
    },
}


def _normalise_relation(value: str) -> str:
    return value.replace('"', "").lower()


def _validate_query(query: str) -> None:
    if not query or not query.strip():
        raise ValueError("EMPTY_QUERY")
    if len(query) > 12_000:
        raise ValueError("QUERY_TOO_LONG")

    cleaned = BLOCK_COMMENT.sub(" ", LINE_COMMENT.sub(" ", query)).strip()
    if ";" in cleaned.rstrip(";"):
        raise ValueError("MULTIPLE_STATEMENTS_NOT_ALLOWED")
    cleaned = cleaned.rstrip(";").strip()

    # Deliberately require a direct SELECT. The approved analytics queries do
    # not need writable CTEs, and excluding WITH makes validation predictable.
    if not re.match(r"^select\b", cleaned, re.IGNORECASE):
        raise ValueError("SELECT_REQUIRED")
    if FORBIDDEN_WORDS.search(cleaned):
        raise ValueError("FORBIDDEN_SQL_OPERATION")
    if FORBIDDEN_OBJECTS.search(cleaned):
        raise ValueError("FORBIDDEN_DATABASE_OBJECT")
    if FORBIDDEN_FUNCTIONS.search(cleaned):
        raise ValueError("FORBIDDEN_DATABASE_FUNCTION")

    relations = [_normalise_relation(item) for item in RELATION_REFERENCE.findall(cleaned)]
    if not relations:
        raise ValueError("APPROVED_VIEW_REQUIRED")
    unapproved = sorted(set(relations) - APPROVED_RELATIONS)
    if unapproved:
        raise ValueError("UNAPPROVED_VIEW")


def _json_default(value: Any) -> Any:
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


class SecureAnalyticsSQL(ComponentWithCache):
    """Execute approved read-only analytics queries and return complete JSON."""

    display_name = "Secure Analytics SQL (JSON)"
    description = (
        "Queries approved analytics_v2 views and returns every selected value "
        "as complete JSON records. Use this before answering production questions."
    )
    icon = "database"
    name = "SecureAnalyticsSQL"

    inputs = [
        MessageTextInput(name="database_url", display_name="Database URL", required=True),
        MultilineInput(
            name="query",
            display_name="SQL Query",
            tool_mode=True,
            required=True,
            info="One read-only SELECT against approved analytics_v2 views.",
        ),
        IntInput(
            name="max_rows",
            display_name="Maximum Rows",
            value=250,
            advanced=True,
            info="Reject results larger than this limit instead of truncating them.",
        ),
    ]

    outputs = [
        Output(display_name="JSON Result", name="run_sql_query", method="run_sql_query"),
    ]

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.db: SQLDatabase | None = None

    def _maybe_create_db(self) -> None:
        if not self.database_url:
            raise ValueError("DATABASE_URL_REQUIRED")
        if self._shared_component_cache:
            cached_db = self._shared_component_cache.get(self.database_url)
            if not isinstance(cached_db, CacheMiss):
                self.db = cached_db
                return
        self.db = SQLDatabase.from_uri(
            self.database_url,
            engine_args=SQL_DATABASE_ENGINE_ARGS,
        )
        if self._shared_component_cache:
            self._shared_component_cache.set(self.database_url, self.db)

    def _safe_message(self, payload: dict[str, Any]) -> Message:
        text = json.dumps(
            payload,
            default=_json_default,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        self.status = text
        return Message(text=text)

    def run_sql_query(self) -> Message:
        try:
            _validate_query(self.query)
        except ValueError as exc:
            return self._safe_message(
                {
                    "status": "error",
                    "error_code": str(exc),
                    "message": "The SQL request was rejected by the analytics safety policy.",
                }
            )

        try:
            self._maybe_create_db()
            cursor = self.db.run(self.query, fetch="cursor")
            fetched = cursor.fetchmany(int(self.max_rows) + 1)
            if len(fetched) > int(self.max_rows):
                return self._safe_message(
                    {
                        "status": "error",
                        "error_code": "RESULT_TOO_LARGE",
                        "message": "Narrow the date, line, or shift filters and try again.",
                    }
                )
            rows = [dict(row._mapping) for row in fetched]
            return self._safe_message(
                {
                    "status": "success",
                    "row_count": len(rows),
                    "rows": rows,
                    "next_action": (
                        "Report no matching records for the exact filters and stop."
                        if not rows
                        else "Answer from these rows and stop unless a distinct detail dataset is explicitly required."
                    ),
                }
            )
        except SQLAlchemyError as exc:
            self.log(f"Analytics SQL execution failed: {type(exc).__name__}")
            return self._safe_message(
                {
                    "status": "error",
                    "error_code": "QUERY_EXECUTION_FAILED",
                    "message": "The approved analytics query could not be completed.",
                }
            )

#!/usr/bin/env python3

import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass


API_URL = "https://api.github.com"
GRAPHQL_URL = f"{API_URL}/graphql"
ALLOWED_REPOSITORY = "drasi-project/drasi-workgraph-demo"
ALLOWED_PROJECT_OWNER = "drasi-project"
AGENT_ID = "issue-validator"
EVENT_TYPE = "CompletedIssueValidation"
MARKER = "WorkGraph-Validation: pass"
STATUS = "AwaitingRouting"
COMMENT_PATTERN = re.compile(
    r"\AWorkGraphEvent/v1[ \t]*\r?\n"
    r"```json[ \t]*\r?\n"
    r"(?P<event_json>.*?)\r?\n```\s*\Z",
    re.DOTALL,
)


class ReporterError(Exception):
    pass


class AmbiguousCreateError(ReporterError):
    pass


@dataclass(frozen=True)
class ReporterConfig:
    token: str
    project_number: int
    profile_ref: str
    comment_author: str
    execution_author: str

    @classmethod
    def from_env(cls):
        token = os.environ.get("WORKGRAPH_GITHUB_TOKEN", "")
        project_number_text = os.environ.get("WORKGRAPH_PROJECT_NUMBER", "")
        profile_ref = os.environ.get("WORKGRAPH_PROFILE_REF", "")
        comment_author = os.environ.get("WORKGRAPH_COMMENT_AUTHOR", "")
        execution_author = os.environ.get("WORKGRAPH_EXECUTION_AUTHOR", "")

        if not token:
            raise ReporterError(
                "WORKGRAPH_GITHUB_TOKEN is not configured from the "
                "COPILOT_MCP_WORKGRAPH_GITHUB_TOKEN Agents secret"
            )
        try:
            project_number = int(project_number_text)
        except ValueError as error:
            raise ReporterError(
                "WORKGRAPH_PROJECT_NUMBER must be a positive integer"
            ) from error
        if project_number <= 0:
            raise ReporterError(
                "WORKGRAPH_PROJECT_NUMBER must be a positive integer"
            )
        if not re.fullmatch(r"issue-validator@[0-9a-fA-F]{40}", profile_ref):
            raise ReporterError(
                "WORKGRAPH_PROFILE_REF must be issue-validator@ followed by "
                "the deployed 40-character profile blob SHA"
            )
        if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})", comment_author):
            raise ReporterError(
                "WORKGRAPH_COMMENT_AUTHOR must be the GitHub login that owns "
                "the configured PAT"
            )
        if not re.fullmatch(
            r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})", execution_author
        ):
            raise ReporterError(
                "WORKGRAPH_EXECUTION_AUTHOR must be the trusted launcher login"
            )
        return cls(
            token=token,
            project_number=project_number,
            profile_ref=profile_ref,
            comment_author=comment_author,
            execution_author=execution_author,
        )


def _require_exact_keys(value, expected, label):
    if not isinstance(value, dict):
        raise ReporterError(f"{label} must be an object")
    actual = set(value)
    expected = set(expected)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise ReporterError(
            f"{label} has invalid properties; missing={missing}, extra={extra}"
        )


def _require_string(value, label):
    if not isinstance(value, str) or not value:
        raise ReporterError(f"{label} must be a non-empty string")


def _require_rfc3339_seconds(value, label):
    _require_string(value, label)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value):
        raise ReporterError(f"{label} must use YYYY-MM-DDTHH:MM:SSZ")
    try:
        datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as error:
        raise ReporterError(f"{label} is not a valid UTC instant") from error


def validate_event(event, config):
    event_keys = {
        "schemaVersion",
        "eventId",
        "eventType",
        "projectItemNodeId",
        "subjectType",
        "subjectNodeId",
        "repository",
        "subjectNumber",
        "actorType",
        "actorId",
        "routeId",
        "responsibilityId",
        "executionId",
        "contentVersion",
        "profileRef",
        "result",
        "completedAt",
    }
    _require_exact_keys(event, event_keys, "event")

    string_fields = event_keys - {"subjectNumber", "result"}
    for field in string_fields:
        _require_string(event[field], f"event.{field}")
    if isinstance(event["subjectNumber"], bool) or not isinstance(
        event["subjectNumber"], int
    ):
        raise ReporterError("event.subjectNumber must be an integer")
    if event["subjectNumber"] <= 0:
        raise ReporterError("event.subjectNumber must be positive")

    fixed_values = {
        "schemaVersion": "workgraph.event/v1",
        "eventType": EVENT_TYPE,
        "subjectType": "Issue",
        "actorType": "Agent",
        "actorId": AGENT_ID,
        "repository": ALLOWED_REPOSITORY,
        "profileRef": config.profile_ref,
    }
    for field, expected in fixed_values.items():
        if event[field] != expected:
            raise ReporterError(f"event.{field} must be {expected!r}")
    if not event["projectItemNodeId"].startswith("PVTI_"):
        raise ReporterError("event.projectItemNodeId must be a ProjectV2 item")
    if not event["subjectNodeId"].startswith("I_"):
        raise ReporterError("event.subjectNodeId must be an Issue node ID")
    if not event["executionId"].startswith("execution:"):
        raise ReporterError("event.executionId must start with 'execution:'")
    expected_event_id = f"event:{event['executionId']}:{EVENT_TYPE}"
    if event["eventId"] != expected_event_id:
        raise ReporterError(
            f"event.eventId must be the deterministic value {expected_event_id!r}"
        )
    _require_rfc3339_seconds(event["completedAt"], "event.completedAt")

    result = event["result"]
    _require_exact_keys(
        result, {"outcome", "reasonCode", "evidence", "summary"}, "event.result"
    )
    evidence = result["evidence"]
    _require_exact_keys(
        evidence, {"requiredMarker", "found"}, "event.result.evidence"
    )
    if evidence["requiredMarker"] != MARKER:
        raise ReporterError(
            f"event.result.evidence.requiredMarker must be {MARKER!r}"
        )
    variants = {
        "passed": (
            "required-marker-present",
            True,
            "The required prototype marker is present.",
        ),
        "failed": (
            "required-marker-missing",
            False,
            "The required prototype marker is missing.",
        ),
    }
    if result["outcome"] not in variants:
        raise ReporterError("event.result.outcome must be 'passed' or 'failed'")
    expected_reason, expected_found, expected_summary = variants[result["outcome"]]
    if result["reasonCode"] != expected_reason:
        raise ReporterError(
            f"event.result.reasonCode must be {expected_reason!r}"
        )
    if evidence["found"] is not expected_found:
        raise ReporterError(
            f"event.result.evidence.found must be {expected_found!r}"
        )
    if result["summary"] != expected_summary:
        raise ReporterError(f"event.result.summary must be {expected_summary!r}")


def canonical_event(event):
    result = event["result"]
    evidence = result["evidence"]
    return {
        "schemaVersion": event["schemaVersion"],
        "eventId": event["eventId"],
        "eventType": event["eventType"],
        "projectItemNodeId": event["projectItemNodeId"],
        "subjectType": event["subjectType"],
        "subjectNodeId": event["subjectNodeId"],
        "repository": event["repository"],
        "subjectNumber": event["subjectNumber"],
        "actorType": event["actorType"],
        "actorId": event["actorId"],
        "routeId": event["routeId"],
        "responsibilityId": event["responsibilityId"],
        "executionId": event["executionId"],
        "contentVersion": event["contentVersion"],
        "profileRef": event["profileRef"],
        "result": {
            "outcome": result["outcome"],
            "reasonCode": result["reasonCode"],
            "evidence": {
                "requiredMarker": evidence["requiredMarker"],
                "found": evidence["found"],
            },
            "summary": result["summary"],
        },
        "completedAt": event["completedAt"],
    }


def format_comment(event):
    payload = json.dumps(canonical_event(event), indent=2, ensure_ascii=True)
    return f"WorkGraphEvent/v1\n```json\n{payload}\n```"


def parse_comment(body):
    if not isinstance(body, str):
        return None
    match = COMMENT_PATTERN.fullmatch(body)
    if not match:
        return None
    try:
        value = json.loads(match.group("event_json"))
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def marker_present(body):
    lines = (body or "").replace("\r\n", "\n").split("\n")
    return any(line == MARKER for line in lines)


class GitHubClient:
    def __init__(self, token):
        self.token = token

    def _request(self, method, url, payload=None, ambiguous_write=False):
        data = None
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "User-Agent": "drasi-workgraph-completion-reporter",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            url, data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read().decode("utf-8")
                try:
                    return json.loads(body) if body else None
                except json.JSONDecodeError as error:
                    raise ReporterError(
                        "GitHub API response is not valid JSON"
                    ) from error
        except urllib.error.HTTPError as error:
            message = error.read().decode("utf-8", errors="replace")
            if ambiguous_write and error.code >= 500:
                raise AmbiguousCreateError(
                    f"comment creation returned HTTP {error.code}"
                ) from error
            try:
                detail = json.loads(message).get("message", message)
            except json.JSONDecodeError:
                detail = message
            raise ReporterError(
                f"GitHub API request failed with HTTP {error.code}: {detail}"
            ) from error
        except (urllib.error.URLError, TimeoutError) as error:
            if ambiguous_write:
                raise AmbiguousCreateError(
                    "comment creation result is ambiguous"
                ) from error
            raise ReporterError(f"GitHub API request failed: {error}") from error

    def _rest(self, method, path, payload=None, ambiguous_write=False):
        return self._request(
            method,
            f"{API_URL}{path}",
            payload=payload,
            ambiguous_write=ambiguous_write,
        )

    def _graphql(self, query, variables):
        response = self._request(
            "POST",
            GRAPHQL_URL,
            payload={"query": query, "variables": variables},
        )
        errors = response.get("errors") if isinstance(response, dict) else None
        if errors:
            messages = "; ".join(
                str(error.get("message", "unknown GraphQL error"))
                for error in errors
            )
            raise ReporterError(f"GitHub GraphQL request failed: {messages}")
        if not isinstance(response, dict) or not isinstance(
            response.get("data"), dict
        ):
            raise ReporterError("GitHub GraphQL response has no data")
        return response["data"]

    def get_identity(self):
        identity = self._rest("GET", "/user")
        if not isinstance(identity, dict) or not identity.get("id"):
            raise ReporterError("GitHub token identity could not be determined")
        return identity

    def get_issue(self, repository, subject_number):
        owner, repo = repository.split("/", 1)
        path = (
            f"/repos/{urllib.parse.quote(owner, safe='')}/"
            f"{urllib.parse.quote(repo, safe='')}/issues/{subject_number}"
        )
        issue = self._rest("GET", path)
        if not isinstance(issue, dict) or issue.get("pull_request") is not None:
            raise ReporterError("completion subject is not an issue")
        return issue

    def list_comments(self, repository, subject_number):
        owner, repo = repository.split("/", 1)
        base = (
            f"/repos/{urllib.parse.quote(owner, safe='')}/"
            f"{urllib.parse.quote(repo, safe='')}/issues/{subject_number}/comments"
        )
        for page in range(1, 101):
            comments = self._rest("GET", f"{base}?per_page=100&page={page}")
            if not isinstance(comments, list):
                raise ReporterError("GitHub comments response is not an array")
            for comment in comments:
                yield comment
            if len(comments) < 100:
                return
        raise ReporterError("comment reconciliation exceeded 100 pages")

    def create_comment(self, repository, subject_number, body):
        owner, repo = repository.split("/", 1)
        path = (
            f"/repos/{urllib.parse.quote(owner, safe='')}/"
            f"{urllib.parse.quote(repo, safe='')}/issues/{subject_number}/comments"
        )
        return self._rest(
            "POST",
            path,
            payload={"body": body},
            ambiguous_write=True,
        )

    def set_awaiting_routing(
        self,
        project_owner,
        project_number,
        project_item_node_id,
        subject_node_id,
    ):
        lookup_query = """
query WorkGraphProject($owner: String!, $number: Int!, $item: ID!) {
  organization(login: $owner) {
    projectV2(number: $number) {
      id
      fields(first: 100) {
        nodes {
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  }
  node(id: $item) {
    ... on ProjectV2Item {
      id
      project { id }
      content {
        ... on Issue { id }
      }
    }
  }
}
"""
        variables = {
            "owner": project_owner,
            "number": project_number,
            "item": project_item_node_id,
        }
        data = self._graphql(lookup_query, variables)
        organization = data.get("organization")
        project = organization.get("projectV2") if organization else None
        item = data.get("node")
        if not project or not item:
            raise ReporterError("configured Project or Project Item was not found")
        if item.get("project", {}).get("id") != project.get("id"):
            raise ReporterError("Project Item does not belong to configured Project")
        if item.get("content", {}).get("id") != subject_node_id:
            raise ReporterError("Project Item does not contain the validated issue")

        status_fields = [
            field
            for field in project.get("fields", {}).get("nodes", [])
            if field
            and field.get("name") == "Status"
            and field.get("id")
        ]
        if len(status_fields) != 1:
            raise ReporterError("configured Project must have exactly one Status field")
        status_field = status_fields[0]
        options = [
            option
            for option in status_field.get("options", [])
            if option.get("name") == STATUS and option.get("id")
        ]
        if len(options) != 1:
            raise ReporterError(
                "configured Project Status field must contain AwaitingRouting"
            )

        mutation = """
mutation WorkGraphAwaitingRouting(
  $project: ID!,
  $item: ID!,
  $field: ID!,
  $option: String!
) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project,
    itemId: $item,
    fieldId: $field,
    value: {singleSelectOptionId: $option}
  }) {
    projectV2Item { id }
  }
}
"""
        mutation_data = self._graphql(
            mutation,
            {
                "project": project["id"],
                "item": project_item_node_id,
                "field": status_field["id"],
                "option": options[0]["id"],
            },
        )
        updated_item = mutation_data.get(
            "updateProjectV2ItemFieldValue", {}
        ).get("projectV2Item")
        if not updated_item or updated_item.get("id") != project_item_node_id:
            raise ReporterError("GitHub did not confirm the Project Item update")

        verify_query = """
query WorkGraphVerifyStatus($item: ID!) {
  node(id: $item) {
    ... on ProjectV2Item {
      fieldValueByName(name: "Status") {
        ... on ProjectV2ItemFieldSingleSelectValue { name }
      }
    }
  }
}
"""
        verify_data = self._graphql(
            verify_query, {"item": project_item_node_id}
        )
        field_value = (verify_data.get("node") or {}).get("fieldValueByName")
        if not field_value or field_value.get("name") != STATUS:
            raise ReporterError("Project Item Status verification failed")
        return STATUS


class CompletionReporter:
    def __init__(self, config, client):
        self.config = config
        self.client = client

    def _find_owned_comment(self, event, identity):
        matches = []
        expected_body = format_comment(event)
        expected_identity = identity["id"]
        for comment in self.client.list_comments(
            event["repository"], event["subjectNumber"]
        ):
            author = comment.get("user") if isinstance(comment, dict) else None
            if not author or author.get("id") != expected_identity:
                continue
            body = comment.get("body")
            parsed = parse_comment(body)
            if parsed == event:
                matches.append(comment)
                continue
            if (
                isinstance(body, str)
                and body.startswith("WorkGraphEvent/v1")
                and event["eventId"] in body
            ):
                raise ReporterError(
                    "authenticated identity already wrote a conflicting "
                    "completion comment for this eventId"
                )
        if len(matches) > 1:
            raise ReporterError(
                "multiple authenticated completion comments exist for eventId"
            )
        if matches and matches[0].get("body") != expected_body:
            raise ReporterError("reconciled completion comment is not canonical")
        return matches[0] if matches else None

    def _validate_active_execution(self, event):
        matches = []
        for comment in self.client.list_comments(
            event["repository"], event["subjectNumber"]
        ):
            if not isinstance(comment, dict):
                continue
            author = comment.get("user") or {}
            if (
                author.get("login", "").lower()
                != self.config.execution_author.lower()
            ):
                continue
            body = comment.get("body")
            if not isinstance(body, str):
                continue
            try:
                record = json.loads(body)
            except json.JSONDecodeError:
                continue
            if not isinstance(record, dict):
                continue
            if record.get("executionId") != event["executionId"]:
                continue
            expected = {
                "schemaVersion": "workgraph.execution/v1",
                "messageType": "execution",
                "routeId": event["routeId"],
                "responsibilityId": event["responsibilityId"],
                "executionId": event["executionId"],
                "expectedEventId": event["eventId"],
                "requiredEventType": event["eventType"],
                "agentProfile": AGENT_ID,
                "profileRef": event["profileRef"],
                "state": "started",
            }
            mismatches = [
                key for key, value in expected.items() if record.get(key) != value
            ]
            if mismatches:
                raise ReporterError(
                    "trusted execution record conflicts with event fields: "
                    + ", ".join(sorted(mismatches))
                )
            for field in (
                "taskId",
                "taskUrl",
                "requestedModel",
                "actualModel",
            ):
                _require_string(record.get(field), f"execution.{field}")
            _require_rfc3339_seconds(
                record.get("startedAt"), "execution.startedAt"
            )
            matches.append(record)
        if len(matches) != 1:
            raise ReporterError(
                "exactly one trusted started execution record must match event"
            )

    def report_completion(self, project_owner, project_number, event):
        if project_owner != ALLOWED_PROJECT_OWNER:
            raise ReporterError(
                f"projectOwner must be {ALLOWED_PROJECT_OWNER!r}"
            )
        if isinstance(project_number, bool) or not isinstance(project_number, int):
            raise ReporterError("projectNumber must be an integer")
        if project_number != self.config.project_number:
            raise ReporterError(
                "projectNumber does not match WORKGRAPH_PROJECT_NUMBER"
            )
        validate_event(event, self.config)

        identity = self.client.get_identity()
        if identity.get("login", "").lower() != self.config.comment_author.lower():
            raise ReporterError(
                "GitHub token identity does not match WORKGRAPH_COMMENT_AUTHOR"
            )
        issue = self.client.get_issue(
            event["repository"], event["subjectNumber"]
        )
        if issue.get("node_id") != event["subjectNodeId"]:
            raise ReporterError("event.subjectNodeId does not match GitHub issue")
        observed_outcome = "passed" if marker_present(issue.get("body")) else "failed"
        if event["result"]["outcome"] != observed_outcome:
            raise ReporterError(
                "event.result does not match the authoritative issue body"
            )
        self._validate_active_execution(event)

        comment = self._find_owned_comment(event, identity)
        reconciled = comment is not None
        if comment is None:
            body = format_comment(event)
            try:
                comment = self.client.create_comment(
                    event["repository"], event["subjectNumber"], body
                )
            except AmbiguousCreateError:
                comment = self._find_owned_comment(event, identity)
                if comment is None:
                    raise ReporterError(
                        "comment creation was ambiguous and no authenticated "
                        "canonical comment could be reconciled"
                    )
                reconciled = True
            author = comment.get("user") if isinstance(comment, dict) else None
            if (
                not author
                or author.get("id") != identity["id"]
                or comment.get("body") != body
            ):
                raise ReporterError(
                    "GitHub did not confirm the authenticated canonical comment"
                )

        comment_node_id = comment.get("node_id")
        if not isinstance(comment_node_id, str) or not comment_node_id:
            raise ReporterError("completion comment has no node ID")

        project_status = self.client.set_awaiting_routing(
            project_owner,
            project_number,
            event["projectItemNodeId"],
            event["subjectNodeId"],
        )
        return {
            "eventId": event["eventId"],
            "commentNodeId": comment_node_id,
            "projectItemNodeId": event["projectItemNodeId"],
            "projectStatus": project_status,
            "reconciled": reconciled,
        }


EVENT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "schemaVersion",
        "eventId",
        "eventType",
        "projectItemNodeId",
        "subjectType",
        "subjectNodeId",
        "repository",
        "subjectNumber",
        "actorType",
        "actorId",
        "routeId",
        "responsibilityId",
        "executionId",
        "contentVersion",
        "profileRef",
        "result",
        "completedAt",
    ],
    "properties": {
        "schemaVersion": {"type": "string", "const": "workgraph.event/v1"},
        "eventId": {"type": "string"},
        "eventType": {"type": "string", "const": EVENT_TYPE},
        "projectItemNodeId": {"type": "string", "pattern": "^PVTI_"},
        "subjectType": {"type": "string", "const": "Issue"},
        "subjectNodeId": {"type": "string", "pattern": "^I_"},
        "repository": {"type": "string", "const": ALLOWED_REPOSITORY},
        "subjectNumber": {"type": "integer", "minimum": 1},
        "actorType": {"type": "string", "const": "Agent"},
        "actorId": {"type": "string", "const": AGENT_ID},
        "routeId": {"type": "string"},
        "responsibilityId": {"type": "string"},
        "executionId": {"type": "string", "pattern": "^execution:"},
        "contentVersion": {"type": "string"},
        "profileRef": {"type": "string"},
        "result": {
            "type": "object",
            "additionalProperties": False,
            "required": ["outcome", "reasonCode", "evidence", "summary"],
            "properties": {
                "outcome": {"type": "string", "enum": ["passed", "failed"]},
                "reasonCode": {
                    "type": "string",
                    "enum": [
                        "required-marker-present",
                        "required-marker-missing",
                    ],
                },
                "evidence": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["requiredMarker", "found"],
                    "properties": {
                        "requiredMarker": {"type": "string", "const": MARKER},
                        "found": {"type": "boolean"},
                    },
                },
                "summary": {"type": "string"},
            },
        },
        "completedAt": {
            "type": "string",
            "pattern": r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$",
        },
    },
}

TOOL = {
    "name": "report_completion",
    "description": (
        "Validate and report one CompletedIssueValidation event, then set only "
        "its configured ProjectV2 Item Status to AwaitingRouting."
    ),
    "inputSchema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["projectOwner", "projectNumber", "event"],
        "properties": {
            "projectOwner": {
                "type": "string",
                "const": ALLOWED_PROJECT_OWNER,
            },
            "projectNumber": {"type": "integer", "minimum": 1},
            "event": EVENT_SCHEMA,
        },
    },
}


def _tool_result(result=None, error=None):
    if error is not None:
        return {
            "content": [{"type": "text", "text": str(error)}],
            "isError": True,
        }
    return {
        "content": [
            {
                "type": "text",
                "text": json.dumps(result, separators=(",", ":")),
            }
        ],
        "structuredContent": result,
        "isError": False,
    }


def handle_request(message):
    method = message.get("method")
    if method == "initialize":
        requested = message.get("params", {}).get(
            "protocolVersion", "2025-06-18"
        )
        return {
            "protocolVersion": requested,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {
                "name": "drasi-workgraph-completion-reporter",
                "version": "1.0.0",
            },
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [TOOL]}
    if method == "tools/call":
        params = message.get("params", {})
        if params.get("name") != "report_completion":
            return _tool_result(error="unknown tool")
        arguments = params.get("arguments")
        try:
            _require_exact_keys(
                arguments,
                {"projectOwner", "projectNumber", "event"},
                "arguments",
            )
            config = ReporterConfig.from_env()
            client = GitHubClient(config.token)
            reporter = CompletionReporter(config, client)
            result = reporter.report_completion(
                arguments["projectOwner"],
                arguments["projectNumber"],
                arguments["event"],
            )
            return _tool_result(result=result)
        except ReporterError as error:
            return _tool_result(error=error)
    raise ReporterError(f"unsupported MCP method: {method}")


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = None
        try:
            message = json.loads(line)
            request_id = message.get("id")
            if request_id is None:
                continue
            result = handle_request(message)
            response = {"jsonrpc": "2.0", "id": request_id, "result": result}
        except (json.JSONDecodeError, ReporterError) as error:
            response = {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32602, "message": str(error)},
            }
        sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

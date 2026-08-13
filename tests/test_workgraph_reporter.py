import copy
import importlib.util
import json
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / ".github" / "mcp" / "workgraph_reporter.py"
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "issue-validator-events.json"
SPEC = importlib.util.spec_from_file_location("workgraph_reporter", MODULE_PATH)
REPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPORTER)


def build_event(variant="passed"):
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    task = fixture["taskPrompt"]
    outcome = fixture[variant]
    return {
        "schemaVersion": "workgraph.event/v1",
        "eventId": task["eventId"],
        "eventType": "CompletedIssueValidation",
        "projectItemNodeId": task["projectItemNodeId"],
        "subjectType": task["subjectType"],
        "subjectNodeId": task["subjectNodeId"],
        "repository": task["repository"],
        "subjectNumber": task["subjectNumber"],
        "actorType": task["actorType"],
        "actorId": task["actorId"],
        "routeId": task["routeId"],
        "responsibilityId": task["responsibilityId"],
        "executionId": task["executionId"],
        "contentVersion": task["contentVersion"],
        "profileRef": task["profileRef"],
        "result": copy.deepcopy(outcome["result"]),
        "completedAt": outcome["completedAt"],
    }


def execution_comment(event):
    body = {
        "schemaVersion": "workgraph.execution/v1",
        "messageType": "execution",
        "routeId": event["routeId"],
        "responsibilityId": event["responsibilityId"],
        "executionId": event["executionId"],
        "expectedEventId": event["eventId"],
        "requiredEventType": event["eventType"],
        "taskId": "task-1",
        "taskUrl": "https://github.com/github/copilot/tasks/task-1",
        "agentProfile": "issue-validator",
        "profileRef": event["profileRef"],
        "requestedModel": "gpt-5.6-sol",
        "actualModel": "gpt-5.4",
        "state": "started",
        "startedAt": "2026-08-13T01:00:05Z",
    }
    return {
        "node_id": "IC_execution",
        "body": json.dumps(body),
        "user": {"id": 7, "login": "workgraph-launcher"},
    }


class FakeGitHubClient:
    def __init__(self, event, body=None):
        self.event = event
        self.body = body if body is not None else "WorkGraph-Validation: pass\n"
        self.calls = []
        self.comment_batches = [[]]
        self.raise_ambiguous = False

    def get_identity(self):
        self.calls.append("get_identity")
        return {"id": 42, "login": "workgraph-reporter"}

    def get_issue(self, repository, subject_number):
        self.calls.append("get_issue")
        return {"node_id": self.event["subjectNodeId"], "body": self.body}

    def list_comments(self, repository, subject_number):
        self.calls.append("list_comments")
        batch = self.comment_batches.pop(0) if self.comment_batches else []
        yield execution_comment(self.event)
        yield from batch

    def create_comment(self, repository, subject_number, body):
        self.calls.append("create_comment")
        if self.raise_ambiguous:
            self.raise_ambiguous = False
            raise REPORTER.AmbiguousCreateError("ambiguous")
        return {
            "node_id": "IC_created",
            "body": body,
            "user": {"id": 42, "login": "workgraph-reporter"},
        }

    def set_awaiting_routing(
        self, project_owner, project_number, item_node_id, subject_node_id
    ):
        self.calls.append("set_status")
        self.status_args = (
            project_owner,
            project_number,
            item_node_id,
            subject_node_id,
        )
        return "AwaitingRouting"


class WorkGraphReporterTest(unittest.TestCase):
    def setUp(self):
        self.config = REPORTER.ReporterConfig(
            token="secret",
            project_number=1,
            profile_ref=(
                "issue-validator@"
                "0123456789abcdef0123456789abcdef01234567"
            ),
            comment_author="workgraph-reporter",
            execution_author="workgraph-launcher",
        )

    def test_exposes_only_scoped_tool(self):
        tools = REPORTER.handle_request({"method": "tools/list"})["tools"]
        self.assertEqual([tool["name"] for tool in tools], ["report_completion"])
        properties = set(tools[0]["inputSchema"]["properties"])
        self.assertEqual(
            properties, {"projectOwner", "projectNumber", "event"}
        )
        serialized = json.dumps(tools[0]["inputSchema"])
        self.assertNotIn("commentBody", serialized)
        self.assertNotIn("statusName", serialized)
        self.assertNotIn("graphql", serialized.lower())

    def test_real_client_sends_configured_token(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"id":42,"login":"workgraph-reporter"}'

        captured = {}

        def urlopen(request, timeout):
            captured["authorization"] = request.get_header("Authorization")
            captured["timeout"] = timeout
            return Response()

        client = REPORTER.GitHubClient("test-token-value")
        with mock.patch.object(REPORTER.urllib.request, "urlopen", urlopen):
            identity = client.get_identity()

        self.assertEqual(identity["id"], 42)
        self.assertEqual(
            captured["authorization"], "Bearer test-token-value"
        )
        self.assertEqual(captured["timeout"], 30)

    def test_config_requires_agents_secret_and_variables(self):
        environment = {
            "WORKGRAPH_GITHUB_TOKEN": "test-token",
            "WORKGRAPH_PROJECT_NUMBER": "1",
            "WORKGRAPH_PROFILE_REF": (
                "issue-validator@"
                "0123456789abcdef0123456789abcdef01234567"
            ),
            "WORKGRAPH_COMMENT_AUTHOR": "workgraph-reporter",
            "WORKGRAPH_EXECUTION_AUTHOR": "workgraph-launcher",
        }
        with mock.patch.dict(REPORTER.os.environ, environment, clear=True):
            config = REPORTER.ReporterConfig.from_env()
        self.assertEqual(config.project_number, 1)
        self.assertEqual(config.comment_author, "workgraph-reporter")

        environment.pop("WORKGRAPH_GITHUB_TOKEN")
        with mock.patch.dict(REPORTER.os.environ, environment, clear=True):
            with self.assertRaisesRegex(
                REPORTER.ReporterError, "Agents secret"
            ):
                REPORTER.ReporterConfig.from_env()

    def test_validates_deterministic_event(self):
        event = build_event()
        REPORTER.validate_event(event, self.config)

        invalid = copy.deepcopy(event)
        invalid["extra"] = True
        with self.assertRaisesRegex(REPORTER.ReporterError, "extra"):
            REPORTER.validate_event(invalid, self.config)

        invalid = copy.deepcopy(event)
        invalid["eventId"] = "caller-selected"
        with self.assertRaisesRegex(REPORTER.ReporterError, "deterministic"):
            REPORTER.validate_event(invalid, self.config)

    def test_creates_comment_before_status(self):
        event = build_event()
        client = FakeGitHubClient(event)
        reporter = REPORTER.CompletionReporter(self.config, client)

        result = reporter.report_completion("drasi-project", 1, event)

        self.assertEqual(result["projectStatus"], "AwaitingRouting")
        self.assertFalse(result["reconciled"])
        self.assertLess(
            client.calls.index("create_comment"),
            client.calls.index("set_status"),
        )
        self.assertEqual(
            client.status_args,
            ("drasi-project", 1, "PVTI_example", "I_example"),
        )

    def test_rejects_result_that_disagrees_with_issue_body(self):
        event = build_event("failed")
        client = FakeGitHubClient(event, body="WorkGraph-Validation: pass\n")
        reporter = REPORTER.CompletionReporter(self.config, client)

        with self.assertRaisesRegex(REPORTER.ReporterError, "issue body"):
            reporter.report_completion("drasi-project", 1, event)

        self.assertNotIn("create_comment", client.calls)
        self.assertNotIn("set_status", client.calls)

    def test_ignores_untrusted_matching_comment(self):
        event = build_event()
        client = FakeGitHubClient(event)
        client.comment_batches = [
            [],
            [
                {
                    "node_id": "IC_untrusted",
                    "body": REPORTER.format_comment(event),
                    "user": {"id": 99, "login": "attacker"},
                }
            ]
        ]
        reporter = REPORTER.CompletionReporter(self.config, client)

        result = reporter.report_completion("drasi-project", 1, event)

        self.assertFalse(result["reconciled"])
        self.assertIn("create_comment", client.calls)

    def test_reconciles_ambiguous_create_from_authenticated_author(self):
        event = build_event()
        client = FakeGitHubClient(event)
        owned_comment = {
            "node_id": "IC_reconciled",
            "body": REPORTER.format_comment(event),
            "user": {"id": 42, "login": "workgraph-reporter"},
        }
        client.comment_batches = [[], [], [owned_comment]]
        client.raise_ambiguous = True
        reporter = REPORTER.CompletionReporter(self.config, client)

        result = reporter.report_completion("drasi-project", 1, event)

        self.assertTrue(result["reconciled"])
        self.assertEqual(result["commentNodeId"], "IC_reconciled")
        self.assertEqual(client.calls.count("create_comment"), 1)
        self.assertLess(
            client.calls.index("create_comment"),
            client.calls.index("set_status"),
        )

    def test_reconciliation_is_independent_of_input_key_order(self):
        event = build_event()
        reordered = dict(reversed(list(event.items())))
        reordered["result"] = dict(
            reversed(list(reordered["result"].items()))
        )
        reordered["result"]["evidence"] = dict(
            reversed(list(reordered["result"]["evidence"].items()))
        )
        owned_comment = {
            "node_id": "IC_existing",
            "body": REPORTER.format_comment(event),
            "user": {"id": 42, "login": "workgraph-reporter"},
        }
        client = FakeGitHubClient(reordered)
        client.comment_batches = [[], [owned_comment]]
        reporter = REPORTER.CompletionReporter(self.config, client)

        result = reporter.report_completion("drasi-project", 1, reordered)

        self.assertTrue(result["reconciled"])
        self.assertNotIn("create_comment", client.calls)
        self.assertIn("set_status", client.calls)

    def test_rejects_untrusted_or_conflicting_execution(self):
        event = build_event()
        client = FakeGitHubClient(event)

        def untrusted_comments(repository, subject_number):
            comment = execution_comment(event)
            comment["user"] = {"id": 99, "login": "attacker"}
            yield comment

        client.list_comments = untrusted_comments
        reporter = REPORTER.CompletionReporter(self.config, client)
        with self.assertRaisesRegex(REPORTER.ReporterError, "started execution"):
            reporter.report_completion("drasi-project", 1, event)

        client = FakeGitHubClient(event)

        def conflicting_comments(repository, subject_number):
            comment = execution_comment(event)
            record = json.loads(comment["body"])
            record["profileRef"] = "issue-validator@" + ("f" * 40)
            comment["body"] = json.dumps(record)
            yield comment

        client.list_comments = conflicting_comments
        reporter = REPORTER.CompletionReporter(self.config, client)
        with self.assertRaisesRegex(REPORTER.ReporterError, "conflicts"):
            reporter.report_completion("drasi-project", 1, event)

    def test_fixed_project_update_verifies_subject_and_status(self):
        class GraphQLClient(REPORTER.GitHubClient):
            def __init__(self):
                super().__init__("test-token")
                self.requests = []

            def _graphql(self, query, variables):
                self.requests.append((query, variables))
                if len(self.requests) == 1:
                    return {
                        "organization": {
                            "projectV2": {
                                "id": "PVT_project",
                                "fields": {
                                    "nodes": [
                                        {
                                            "id": "PVTSSF_status",
                                            "name": "Status",
                                            "options": [
                                                {
                                                    "id": "option-awaiting",
                                                    "name": "AwaitingRouting",
                                                }
                                            ],
                                        }
                                    ]
                                },
                            }
                        },
                        "node": {
                            "id": "PVTI_example",
                            "project": {"id": "PVT_project"},
                            "content": {"id": "I_example"},
                        },
                    }
                if len(self.requests) == 2:
                    return {
                        "updateProjectV2ItemFieldValue": {
                            "projectV2Item": {"id": "PVTI_example"}
                        }
                    }
                return {
                    "node": {
                        "fieldValueByName": {"name": "AwaitingRouting"}
                    }
                }

        client = GraphQLClient()
        status = client.set_awaiting_routing(
            "drasi-project", 1, "PVTI_example", "I_example"
        )

        self.assertEqual(status, "AwaitingRouting")
        self.assertEqual(len(client.requests), 3)
        mutation_query, mutation_variables = client.requests[1]
        self.assertIn("updateProjectV2ItemFieldValue", mutation_query)
        self.assertEqual(mutation_variables["item"], "PVTI_example")
        self.assertEqual(mutation_variables["option"], "option-awaiting")
        self.assertIn("fieldValueByName", client.requests[2][0])


if __name__ == "__main__":
    unittest.main()

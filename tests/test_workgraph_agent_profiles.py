import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / ".github" / "agents"
REPORTER = ROOT / ".github" / "mcp" / "workgraph-reporter.mjs"
PROFILE = (
    ROOT
    / ".github"
    / "workgraph"
    / "profiles"
    / "issue-validation"
    / "new-issue-default.md"
)
DOC = ROOT / "docs" / "workgraph-result-reporter.md"
README = ROOT / "README.md"
AGENTS_CONFIG = ROOT / ".github" / "workgraph" / "agents.yaml"

EXPECTED_TOOLS = {
    "issue-orchestrator": ["github/issue_read", "workgraph/transition_issue"],
    "issue-assigner": [
        "github/issue_read",
        "workgraph/submit_task_assignment",
    ],
    "issue-validator": [
        "github/issue_read",
        "workgraph/submit_task_result",
    ],
    "issue-info-requester": [
        "github/issue_read",
        "workgraph/post_parent_info_request",
        "workgraph/submit_task_result",
    ],
    "workgraph-result-acceptor": [
        "github/issue_read",
        "workgraph/get_result_snapshot",
        "workgraph/submit_result_acceptance",
        "workgraph/submit_task_feedback",
    ],
    "issue-title-validator": [
        "github/issue_read",
        "workgraph/submit_workflow_task_result",
    ],
    "issue-body-validator": [
        "github/issue_read",
        "workgraph/submit_workflow_task_result",
    ],
    "issue-validation-evaluator": [
        "github/issue_read",
        "workgraph/submit_workflow_task_result",
    ],
}

COMMON_ENV_KEYS = {
    "COPILOT_MCP_WORKGRAPH_TOKEN",
    "COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID",
    "COPILOT_MCP_WORKGRAPH_LAUNCHER_USER_ID",
}
LEASE_ENV_KEYS = {
    "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_URL",
    "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN",
}
WORKFLOW_AGENT_ENV_KEYS = (
    COMMON_ENV_KEYS
    | {
        "COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID",
        "COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID",
    }
    | LEASE_ENV_KEYS
)
EXPECTED_ENV_KEYS = {
    "issue-assigner": COMMON_ENV_KEYS
    | {"COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID"},
    "issue-validator": COMMON_ENV_KEYS
    | {
        "COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID",
        "COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID",
        "COPILOT_MCP_WORKGRAPH_FEEDBACK_REPORTER_USER_ID",
    }
    | LEASE_ENV_KEYS,
    "issue-info-requester": COMMON_ENV_KEYS
    | {
        "COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID",
        "COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID",
        "COPILOT_MCP_WORKGRAPH_ACCEPTANCE_REPORTER_USER_ID",
        "COPILOT_MCP_WORKGRAPH_INFO_REPORTER_USER_ID",
        "COPILOT_MCP_WORKGRAPH_FEEDBACK_REPORTER_USER_ID",
    }
    | LEASE_ENV_KEYS,
    "workgraph-result-acceptor": COMMON_ENV_KEYS
    | {
        "COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID",
        "COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID",
        "COPILOT_MCP_WORKGRAPH_ACCEPTANCE_REPORTER_USER_ID",
        "COPILOT_MCP_WORKGRAPH_FEEDBACK_REPORTER_USER_ID",
    },
    "issue-orchestrator": COMMON_ENV_KEYS
    | {
        "COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID",
        "COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID",
        "COPILOT_MCP_WORKGRAPH_ACCEPTANCE_REPORTER_USER_ID",
        "COPILOT_MCP_WORKGRAPH_ORCHESTRATOR_USER_ID",
        "COPILOT_MCP_WORKGRAPH_INFO_REPORTER_USER_ID",
        "COPILOT_MCP_WORKGRAPH_FEEDBACK_REPORTER_USER_ID",
    },
    "issue-title-validator": WORKFLOW_AGENT_ENV_KEYS,
    "issue-body-validator": WORKFLOW_AGENT_ENV_KEYS,
    "issue-validation-evaluator": WORKFLOW_AGENT_ENV_KEYS,
}
SECRET_ENV_KEYS = {
    "COPILOT_MCP_WORKGRAPH_TOKEN",
    "COPILOT_MCP_WORKGRAPH_LEASE_VALIDATION_TOKEN",
}


class WorkGraphProfilesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.agents = {
            path.name.removesuffix(".agent.md"): path.read_text(encoding="utf-8")
            for path in AGENTS.glob("*.agent.md")
        }
        cls.reporter = REPORTER.read_text(encoding="utf-8")
        cls.profile = PROFILE.read_text(encoding="utf-8")
        cls.doc = DOC.read_text(encoding="utf-8")
        cls.readme = README.read_text(encoding="utf-8")
        cls.agent_config = AGENTS_CONFIG.read_text(encoding="utf-8")

    def test_exactly_eight_rest_launchable_profiles(self):
        self.assertEqual(set(self.agents), set(EXPECTED_TOOLS))
        self.assertNotIn("risk-profiler", "\n".join(self.agents.values()))
        for name, content in self.agents.items():
            with self.subTest(name=name):
                frontmatter = content.split("---", 2)[1]
                self.assertRegex(frontmatter, rf"(?m)^name: {name}$")
                self.assertRegex(frontmatter, r"(?m)^user-invocable: true$")
                self.assertRegex(
                    frontmatter, r"(?m)^disable-model-invocation: false$"
                )
                self.assertIn("target: github-copilot", frontmatter)
                tools_block = frontmatter.split("tools:", 1)[1].split(
                    "mcp-servers:", 1
                )[0]
                tools = re.findall(r"(?m)^  - (\S+)$", tools_block)
                self.assertEqual(tools, EXPECTED_TOOLS[name])
                self.assertNotIn("github/issue_write", frontmatter)
                self.assertNotIn("github/add_issue_comment", frontmatter)
                server_block = frontmatter.split("mcp-servers:", 1)[1].split(
                    "env:", 1
                )[0]
                server_tools = re.findall(
                    r"(?m)^      - (\S+)$",
                    server_block.split("\n    tools:", 1)[1],
                )
                self.assertEqual(
                    server_tools,
                    [
                        tool.removeprefix("workgraph/")
                        for tool in EXPECTED_TOOLS[name]
                        if tool.startswith("workgraph/")
                    ],
                )
                self.assertNotRegex(frontmatter, r"(?m)^\s*resources:")

    def test_profiles_expose_only_required_environment(self):
        for name, content in self.agents.items():
            with self.subTest(name=name):
                self.assertIn(
                    "COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID: "
                    "${{ vars.COPILOT_MCP_WORKGRAPH_TASK_ISSUE_TYPE_ID }}",
                    content,
                )
                self.assertIn(
                    "COPILOT_MCP_WORKGRAPH_TOKEN: "
                    "${{ secrets.COPILOT_MCP_WORKGRAPH_TOKEN }}",
                    content,
                )
                frontmatter = content.split("---", 2)[1]
                env = dict(
                    re.findall(r"(?m)^      ([A-Z0-9_]+): (.+)$", frontmatter)
                )
                self.assertEqual(set(env), EXPECTED_ENV_KEYS[name])
                for key, value in env.items():
                    namespace = "secrets" if key in SECRET_ENV_KEYS else "vars"
                    self.assertEqual(value, f"${{{{ {namespace}.{key} }}}}")

    def test_task_contract_is_exact_and_closed(self):
        for text in [self.doc, self.reporter]:
            self.assertIn("WorkGraphTask/v1", text)
            self.assertIn("validate-issue", text)
            self.assertIn("request-info", text)
            self.assertIn("new-issue-default", text)
            self.assertIn("validationResultCommentNodeId", text)
        self.assertIn("minimal canonical YAML grammar", self.doc)
        self.assertIn("generic task\nregistry", self.doc)
        self.assertIn('const TASK_TYPE_NAME = "WorkGraphTask"', self.reporter)
        self.assertNotIn("issue-risk-profile", self.reporter)
        production = "\n".join(
            [self.reporter, self.doc, self.readme, *self.agents.values()]
        )
        for legacy in (
            "agentProfile",
            "workerId",
            "compatibleWorkers",
            "queueDepth",
            "workers.yaml",
        ):
            self.assertNotIn(legacy, production)

    def test_exact_comment_contracts_and_result_fields(self):
        for marker in (
            "WorkGraphTaskAssignment/v1",
            "WorkGraphTaskResult/v1",
            "WorkGraphTaskFeedback/v1",
            "WorkGraphTaskResultAcceptance/v1",
        ):
            self.assertIn(marker, self.doc)
            self.assertIn(marker, self.reporter)
        sources = "\n".join(
            [self.doc, self.reporter, self.readme, *self.agents.values()]
        )
        self.assertNotRegex(sources, r"WorkGraphTask(?:Assignment|Result)/v[2-9]")
        self.assertNotRegex(sources, r"WorkGraphTaskLease(?:Expiration)?/")
        self.assertNotIn("lease" + "CommentNodeId", sources)
        self.assertIn('"agentId": "issue-validator"', self.doc)
        self.assertIn('"leaseId": "lease-001"', self.doc)
        self.assertIn("There is no `assignmentId`", self.doc)
        self.assertNotIn('"assignmentId":', self.reporter)
        for field in [
            "requestCommentNodeId",
            "resultCommentNodeId",
            "resultBodyDigest",
        ]:
            self.assertIn(field, self.doc)
            self.assertIn(field, self.reporter)
        self.assertIn("sha256:<64 lowercase hex>", self.reporter)
        self.assertNotRegex(
            self.reporter,
            r"canonical\s*=\s*\{[^}]*bodyDigest",
        )

    def test_agent_config_schema_and_stable_metadata(self):
        self.assertEqual(self.agent_config.count("\n  - agentId: "), 5)
        self.assertIn("version: 1\nagents:\n", self.agent_config)
        entries = re.findall(
            r"  - agentId: ([A-Za-z0-9._-]+)\n"
            r"    slots: (\d+)\n"
            r"    leaseDuration: ([A-Z0-9]+)\n",
            self.agent_config,
        )
        self.assertEqual(
            {agent_id for agent_id, _, _ in entries},
            {
                "issue-validator",
                "issue-info-requester",
                "issue-title-validator",
                "issue-body-validator",
                "issue-validation-evaluator",
            },
        )
        for agent_id, slots, duration in entries:
            self.assertEqual(slots, "1")
            self.assertEqual(duration, "PT30M")
        self.assertIn(".github/workgraph/agents.yaml", self.doc)
        self.assertIn("desired capacity only", self.doc)

    def test_reporter_exposes_only_narrow_tools(self):
        names = re.findall(
            r'(?m)^    name: "(get_result_snapshot|submit_task_assignment|submit_task_result|'
            r'submit_workflow_task_assignment|submit_workflow_task_result|'
            r'submit_result_acceptance|transition_issue|'
            r'post_parent_info_request|submit_task_feedback)"',
            self.reporter,
        )
        self.assertEqual(set(names), {
            "get_result_snapshot",
            "submit_task_assignment",
            "submit_task_result",
            "submit_workflow_task_assignment",
            "submit_workflow_task_result",
            "submit_result_acceptance",
            "transition_issue",
            "post_parent_info_request",
            "submit_task_feedback",
        })
        self.assertNotIn("report_progress", self.reporter)
        self.assertNotIn("issue-risk", self.reporter)
        self.assertIn('patchComment(id, body)', self.reporter)
        self.assertIn("ensureTransitionTask", self.reporter)
        self.assertIn("findUnattachedTransitionTask", self.reporter)
        self.assertNotIn("state_reason", self.reporter)

    def test_orchestrator_state_machine_and_reconciliation_are_explicit(self):
        orchestrator = self.agents["issue-orchestrator"]
        for value in [
            "status:new",
            "status:awaiting-validation",
            "status:awaiting-need-info",
            "status:awaiting-triage",
            "start-validation",
            "advance-validation",
            "resume-after-human-reply",
            "stale supplied status",
            "unexpected open sibling",
            "no-op",
        ]:
            self.assertIn(value, orchestrator)
        self.assertIn("Canonical title/body correlation", self.doc)
        self.assertIn("without creating another task", self.doc)
        self.assertIn("never type or untype an Issue", orchestrator)
        self.assertIn("initial create request", orchestrator)
        self.assertIn("No tool exposes\nIssue Type mutation", self.doc)

    def test_agent_and_acceptor_provenance_rules(self):
        validator = self.agents["issue-validator"]
        self.assertIn(
            "native parent; that relation is authoritative",
            " ".join(validator.split()),
        )
        self.assertIn('outcome:\n"succeeded"', validator)
        self.assertIn(
            "PATCHes the existing canonical Result",
            " ".join(validator.split()),
        )

        requester = self.agents["issue-info-requester"]
        self.assertIn("mentions the parent's submitter", requester)
        self.assertIn("requestCommentNodeId", requester)

        acceptor = self.agents["workgraph-result-acceptor"]
        self.assertIn("exact current Result", acceptor)
        self.assertIn("SHA-256", acceptor)
        self.assertIn("submit no Acceptance", acceptor)
        self.assertIn("Source may allocate a later Lease", acceptor)
        self.assertIn("PATCHes the one feedback comment", acceptor)

    def test_request_info_acceptance_uses_failed_criteria_deterministically(self):
        acceptor = self.agents["workgraph-result-acceptor"]
        normalized = " ".join(acceptor.split())
        for value in (
            "exact criterion strings",
            "passed: false",
            "authoritative requested items",
            "The Issue body is present",
            "Never reinterpret a criterion name",
            "concrete factual or canonical-contract mismatch",
            "Wording preference alone is not a mismatch",
        ):
            self.assertIn(value, normalized)
        self.assertIn("exact current", self.doc)

    def test_workflow_agents_are_simple_and_manifest_bound(self):
        title = self.agents["issue-title-validator"]
        body = self.agents["issue-body-validator"]
        evaluator = self.agents["issue-validation-evaluator"]
        for profile, branch, operation, field in (
            (title, "title", "validate-title", "title"),
            (body, "body", "validate-body", "body"),
        ):
            with self.subTest(branch=branch):
                self.assertIn(f"branch `{branch}`", profile)
                self.assertIn(f"operation `{operation}`", profile)
                self.assertIn(f'"field": "{field}"', profile)
                self.assertIn('"passed": true', profile)
                self.assertIn("whitespace-only", profile.lower())
                self.assertIn("submit_workflow_task_result", profile)
        normalized = " ".join(evaluator.split())
        self.assertIn("join: all", evaluator)
        self.assertIn("expectedChildCount: 2", evaluator)
        self.assertIn("Choose `triage` only when both", normalized)
        self.assertIn("Otherwise choose `request-info`", normalized)
        self.assertIn("Never invent another decision", normalized)

    def test_agents_handle_optional_feedback_dispatch(self):
        for name in ("issue-validator", "issue-info-requester"):
            profile = self.agents[name]
            normalized = " ".join(profile.split())
            with self.subTest(agent=name):
                for field in (
                    "feedbackCommentNodeId",
                    "feedbackUpdatedAt",
                    "resultCommentNodeId",
                    "resultBodyDigest",
                ):
                    self.assertIn(field, profile)
                self.assertIn("exact prior Result and feedback comment", normalized)
                self.assertIn("materially revised", normalized)
                self.assertIn("do not merely reconcile an unchanged", normalized.lower())
                self.assertIn("narrow reporter remains authoritative", normalized)
        requester = self.agents["issue-info-requester"]
        self.assertIn("exact `passed: false` validation criteria", requester)
        self.assertIn("cannot require\ninventing, removing, or rephrasing", requester)
        self.assertIn("semantic\nResult must materially change", self.doc)

    def test_dispatch_ids_and_readable_evidence_are_separated(self):
        self.assertIn("opaque graph node IDs", self.doc)
        self.assertIn("independently re-fetch", self.doc)
        for name, profile in self.agents.items():
            with self.subTest(agent=name):
                self.assertIn("trusted graph dispatch envelope", profile)
                self.assertIn(
                    "Pass opaque node IDs through unchanged",
                    " ".join(profile.split()),
                )
                self.assertIn("Do not stop", profile)
                self.assertIn("independently", profile)

    def test_fail_closed_race_and_feedback_revision_are_documented(self):
        self.assertIn("fail-closed pre/post reconciliation", self.doc)
        self.assertIn("no compensating delete", self.doc)
        self.assertIn("requires manual remediation", self.doc)
        self.assertIn("binds actionable feedback to the exact current", self.doc)
        self.assertIn("resultBodyDigest", self.reporter)
        self.assertIn("Result/Acceptance race left the task inconsistent", self.reporter)
        self.assertNotIn("deleteComment", self.reporter)

    def test_result_and_acceptance_never_close_task(self):
        sources = "\n".join(
            [self.reporter, self.doc, self.readme, *self.agents.values()]
        )
        self.assertIn("A Result never closes a task", self.readme)
        self.assertIn("A Result never changes Issue state and never\ncloses the task", self.doc)
        self.assertNotRegex(self.reporter, r'["`]state["`]\s*:')
        self.assertNotIn("closeIssue", self.reporter)
        self.assertIn("external WorkGraph runtime may close", sources)

    def test_source_lease_contract_is_exact(self):
        for value in (
            '"taskNodeId": "I_task"',
            '"assignmentCommentNodeId": "IC_assignment"',
            '"agentId": "issue-validator"',
            '"slotId": "issue-validator/1"',
            '"taskType": "validate-issue"',
            "POST {webhook.path}/lease/validate",
            "exactly those five fields",
            "exact\neight-field active Lease snapshot",
            "Source remains authoritative",
        ):
            self.assertIn(value, self.doc)

    def test_agents_require_source_lease_and_no_agent_writes_one(self):
        for name in (
            "issue-validator",
            "issue-info-requester",
            "issue-title-validator",
            "issue-body-validator",
            "issue-validation-evaluator",
        ):
            profile = self.agents[name]
            normalized = " ".join(profile.split())
            self.assertIn("active Source-issued Lease", normalized)
            self.assertIn("Without every Lease field, stop and submit nothing", normalized)
            self.assertIn("Never run without a Lease", normalized)
            self.assertIn("Never", profile)
        self.assertIn("never allocates", self.doc)
        self.assertNotIn("submit_task_lease", self.reporter)
        self.assertNotIn("create_lease", self.reporter)

    def test_repository_validation_profile_is_unchanged_two_criteria(self):
        self.assertTrue(
            self.profile.endswith(
                "## Criteria\n\n"
                "1. The Issue has a non-empty title\n"
                "2. The Issue body is present\n"
            )
        )
        self.assertEqual(self.profile.count("\n1. "), 1)
        self.assertEqual(self.profile.count("\n2. "), 1)
        self.assertNotIn("\r", self.profile)


if __name__ == "__main__":
    unittest.main()

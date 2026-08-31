import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / ".github" / "agents"
AGENTS_CONFIG = ROOT / ".github" / "workgraph" / "agents.yaml"
WORKFLOW = ROOT / ".github" / "workgraph" / "workflows" / "issue-lifecycle.yaml"
DEFINITION = ROOT / ".github" / "mcp" / "workgraph-v1-definition.mjs"

EXPECTED_TOOLS = {
    "issue-validator": [
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
    "issue-coordinator": ["workgraph/submit_task_result"],
    "issue-worker": [
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
    "result-evaluator": [
        "workgraph/get_task_snapshot",
        "workgraph/submit_task_evaluation",
    ],
    "issue-validation-evaluator": [
        "workgraph/get_task_snapshot",
        "workgraph/submit_task_evaluation",
    ],
    "workflow-coordinator": [
        "workgraph/get_task_snapshot",
        "workgraph/submit_task_route",
    ],
    "validation-stage-coordinator": [
        "workgraph/get_task_snapshot",
        "workgraph/submit_task_route",
    ],
    "issue-info-requester": [
        "workgraph/get_root_issue",
        "workgraph/submit_task_result",
    ],
}


class WorkGraphProfilesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.agents = {
            path.name.removesuffix(".agent.md"): path.read_text(encoding="utf-8")
            for path in AGENTS.glob("*.agent.md")
        }
        cls.agent_config = AGENTS_CONFIG.read_text(encoding="utf-8")
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")
        cls.definition = DEFINITION.read_text(encoding="utf-8")

    def test_profiles_are_the_exact_worker_and_lifecycle_role_set(self):
        self.assertEqual(set(self.agents), set(EXPECTED_TOOLS))
        for name, content in self.agents.items():
            with self.subTest(name=name):
                frontmatter = content.split("---", 2)[1]
                self.assertRegex(frontmatter, rf"(?m)^name: {name}$")
                self.assertRegex(frontmatter, r"(?m)^target: github-copilot$")
                self.assertRegex(frontmatter, r"(?m)^user-invocable: true$")
                self.assertRegex(
                    frontmatter, r"(?m)^disable-model-invocation: false$"
                )
                tools = re.findall(r"(?m)^  - (\S+)$", frontmatter)
                self.assertEqual(tools, EXPECTED_TOOLS[name])
                self.assertNotIn("github/issue_write", frontmatter)
        for name in EXPECTED_TOOLS:
            with self.subTest(runtime_profile=name):
                self.assertIn("mcp-servers:", self.agents[name])
                self.assertIn(
                    ".github/mcp/workgraph-reporter.mjs",
                    self.agents[name],
                )
                server_tools = re.findall(
                    r"(?m)^      - (\S+)$",
                    self.agents[name]
                    .split("\n    tools:", 1)[1]
                    .split("\n    env:", 1)[0],
                )
                self.assertEqual(
                    server_tools,
                    [tool.removeprefix("workgraph/") for tool in EXPECTED_TOOLS[name]],
                )

    def test_agent_capacity_registers_every_profile_once(self):
        entries = re.findall(
            r"  - agentId: ([A-Za-z0-9._-]+)\n"
            r"    slots: (\d+)\n"
            r"    leaseDuration: ([A-Z0-9]+)\n",
            self.agent_config,
        )
        self.assertEqual([name for name, _, _ in entries], list(EXPECTED_TOOLS))
        self.assertEqual(len(entries), len(set(name for name, _, _ in entries)))
        self.assertTrue(all(int(slots) > 0 for _, slots, _ in entries))

    def test_evaluators_and_coordinators_write_on_existing_tasks(self):
        for name in ("result-evaluator", "issue-validation-evaluator"):
            with self.subTest(name=name):
                self.assertIn("existing", self.agents[name].lower())
                self.assertIn("WorkGraphTaskEvaluate/v1", self.agents[name])
                self.assertNotRegex(
                    self.agents[name], r"workgraph/(?:create|assign|dispatch)_task"
                )
        for name in ("workflow-coordinator", "validation-stage-coordinator"):
            with self.subTest(name=name):
                self.assertIn("WorkGraphTaskRoute/v1", self.agents[name])
                self.assertRegex(self.agents[name], r"(?i)never create")
                self.assertNotRegex(
                    self.agents[name], r"workgraph/(?:create|assign|dispatch)_task"
                )

    def test_workflow_reuses_profiles_and_declares_both_overrides(self):
        for profile in set(EXPECTED_TOOLS) - {"issue-coordinator"}:
            self.assertIn(profile, self.workflow)
        self.assertRegex(
            self.workflow,
            r"(?m)^    evaluator: result-evaluator$",
        )
        self.assertRegex(
            self.workflow,
            r"(?m)^      evaluator: issue-validation-evaluator$",
        )
        self.assertRegex(
            self.workflow,
            r"(?m)^    orchestrator: workflow-coordinator$",
        )
        self.assertRegex(
            self.workflow,
            r"(?m)^      orchestrator: validation-stage-coordinator$",
        )
        self.assertNotIn("agent:", self.workflow)
        self.assertEqual(self.workflow.count("worker: issue-worker"), 6)
        self.assertEqual(self.workflow.count("worker: issue-validator"), 4)
        self.assertIn("maxReworkAttempts: 3", self.workflow)
        self.assertNotRegex(self.workflow, r"(?m)^\s+maxRework:")

    def test_contract_surfaces_use_only_clean_v1_terms(self):
        production = "\n".join(
            [
                self.workflow,
                self.definition,
                self.agent_config,
                *self.agents.values(),
            ]
        )
        for marker in (
            "WorkGraphWorkflowDefinition/v1",
            "WorkGraphTask/v1",
            "WorkGraphTaskResult/v1",
            "WorkGraphTaskEvaluate/v1",
            "WorkGraphTaskRoute/v1",
        ):
            self.assertIn(marker, production)
        self.assertIn("Root Issue", production)
        self.assertIn("Root Task", production)
        self.assertNotRegex(production, r"WorkGraph[A-Za-z]*/v[23]")
        self.assertNotRegex(production, r"(?i)\bvnext\b")
        self.assertNotRegex(production, r"(?i)\bcompatibility\b")
        self.assertNotRegex(production, r"(?i)status:\s*new")
        self.assertNotRegex(production, r"(?i)admission[- ]bridge")
        self.assertNotRegex(production, r"(?i)\bdemo-[a-z0-9-]+\b")


if __name__ == "__main__":
    unittest.main()

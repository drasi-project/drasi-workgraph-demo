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
    "assignment-coordinator": [
        "workgraph/get_task_snapshot",
        "workgraph/submit_task_assignment",
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
                self.assertIn(
                    "urn:drasi:workgraph:id:v1:task:sha256:<64 lowercase hex>", content
                )
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

    def test_actor_catalog_registers_every_profile_and_the_human_actor(self):
        """The `version: 2` actor catalog is the single executor namespace.

        A workflow references an actor ID identically whoever executes it; only
        this catalog decides whether that actor is an agent or a human.
        """
        self.assertRegex(self.agent_config, r"(?m)^version: 2$")
        self.assertNotRegex(self.agent_config, r"(?m)^agents:$")
        entries = re.findall(
            r"  - actorId: ([A-Za-z0-9._-]+)\n"
            r"    kind: (agent|human)\n"
            r"    slots: (\d+)\n"
            r"    leaseDuration: (P[A-Z0-9]+)\n",
            self.agent_config,
        )
        actor_ids = [actor_id for actor_id, _, _, _ in entries]
        self.assertEqual(len(actor_ids), len(set(actor_ids)))
        self.assertTrue(all(int(slots) > 0 for _, _, slots, _ in entries))
        # Every custom-agent profile is an agent actor, with its original
        # capacity and the default `customAgent` (its own actor ID).
        agents = [actor_id for actor_id, kind, _, _ in entries if kind == "agent"]
        self.assertEqual(agents, list(EXPECTED_TOOLS))
        self.assertNotIn("customAgent:", self.agent_config)
        self.assertEqual(
            [(actor_id, slots, duration) for actor_id, kind, slots, duration in entries
             if kind == "agent"],
            [
                ("issue-validator", "1", "PT30M"),
                ("issue-coordinator", "1", "PT15M"),
                ("issue-worker", "2", "PT30M"),
                ("result-evaluator", "1", "PT15M"),
                ("issue-validation-evaluator", "1", "PT15M"),
                ("workflow-coordinator", "1", "PT15M"),
                ("validation-stage-coordinator", "1", "PT15M"),
                ("issue-info-requester", "1", "PT30M"),
                ("assignment-coordinator", "1", "PT15M"),
            ],
        )
        # Exactly one human actor, bound to the exact GitHub account it speaks
        # as. A human actor has no custom-agent profile by construction.
        humans = [
            (actor_id, slots, duration)
            for actor_id, kind, slots, duration in entries
            if kind == "human"
        ]
        self.assertEqual(humans, [("human-agentofreality", "1", "PT8H")])
        self.assertNotIn("human-agentofreality", EXPECTED_TOOLS)
        self.assertIn(
            "    github:\n"
            "      databaseId: 4021243\n"
            '      nodeId: "MDQ6VXNlcjQwMjEyNDM="\n'
            "      login: agentofreality\n",
            self.agent_config,
        )
        self.assertEqual(self.agent_config.count("    github:\n"), 1)

    def test_evaluators_and_coordinators_write_on_existing_tasks(self):
        lifecycle_profiles = (
            "assignment-coordinator",
            "result-evaluator",
            "issue-validation-evaluator",
            "workflow-coordinator",
            "validation-stage-coordinator",
        )
        for name in lifecycle_profiles:
            with self.subTest(reporter_identity=name):
                self.assertIn(
                    "COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID: "
                    "${{ vars.COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID }}",
                    self.agents[name],
                )
        for name in lifecycle_profiles[1:3]:
            with self.subTest(name=name):
                self.assertIn(
                    "COPILOT_MCP_WORKGRAPH_EVALUATION_REPORTER_USER_ID: "
                    "${{ vars.COPILOT_MCP_WORKGRAPH_EVALUATION_REPORTER_USER_ID }}",
                    self.agents[name],
                )
                self.assertIn("existing", self.agents[name].lower())
                self.assertIn("WorkGraphTaskEvaluation/v1", self.agents[name])
                self.assertNotRegex(
                    self.agents[name], r"workgraph/(?:create|assign|dispatch)_task"
                )
        self.assertIn(
            "WorkGraphTaskAssignment/v1",
            self.agents["assignment-coordinator"],
        )
        for name in lifecycle_profiles[3:]:
            with self.subTest(name=name):
                self.assertIn("WorkGraphTaskRoute/v1", self.agents[name])
                self.assertRegex(self.agents[name], r"(?i)never create")
                self.assertNotRegex(
                    self.agents[name], r"workgraph/(?:create|assign|dispatch)_task"
                )

    def test_reporter_identities_map_from_their_own_variables(self):
        """Each reporter identity reads the identically named variable.

        A bare `vars.COPILOT_MCP_WORKGRAPH_REPORTER_USER_ID` is not a declared
        repository variable, so any profile referencing it resolves the
        identity to the empty string: a required identity then fails closed at
        configuration time, and an optional one silently falls back.
        """
        identity = re.compile(
            r"^\s*(COPILOT_MCP_WORKGRAPH_\w*?_?REPORTER_USER_ID): "
            r"\$\{\{ vars\.(\S+) \}\}$",
            re.MULTILINE,
        )
        seen = set()
        for name, content in self.agents.items():
            with self.subTest(name=name):
                self.assertNotIn(
                    "vars.COPILOT_MCP_WORKGRAPH_REPORTER_USER_ID", content
                )
                declared = identity.findall(content)
                self.assertNotEqual(declared, [])
                for key, source in declared:
                    self.assertEqual(key, source)
                    seen.add(key)
        # Every profile resolves the Route author identity, because worker
        # tools authenticate a routed scope member's predecessor Route.
        for name, content in self.agents.items():
            with self.subTest(route_identity=name):
                self.assertIn(
                    "COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID: "
                    "${{ vars.COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID }}",
                    content,
                )
        self.assertEqual(
            seen,
            {
                "COPILOT_MCP_WORKGRAPH_ASSIGNMENT_REPORTER_USER_ID",
                "COPILOT_MCP_WORKGRAPH_RESULT_REPORTER_USER_ID",
                "COPILOT_MCP_WORKGRAPH_EVALUATION_REPORTER_USER_ID",
                "COPILOT_MCP_WORKGRAPH_ROUTE_REPORTER_USER_ID",
            },
        )

    def test_coordinator_supports_legacy_and_scoped_container_cleanup(self):
        """The coordinator derives its children instead of hardcoding one key.

        A scoped Run cleanup carries `flowEntryTerminals` and forks one entry
        task per declared `flowEntries` step, so a profile pinned to exactly
        one `validate` child exits without submitting.
        """
        profile = self.agents["issue-coordinator"]
        self.assertIn("flowEntryTerminals", profile)
        self.assertIn("flowEntries", profile)
        # Children come from the pinned task definition, not a fixed key.
        self.assertIn("children[].taskDefinitionId", profile)
        self.assertRegex(profile, r"(?i)rather than any fixed\s+task key")
        self.assertNotRegex(
            profile, r"exactly\s+one direct child with task key `validate`"
        )
        # Both shapes stay supported, and mixing them is rejected.
        self.assertRegex(profile, r"(?i)legacy isolated")
        self.assertIn("proofMode: isolated", profile)
        self.assertRegex(profile, r"(?i)scoped run cleanup")
        self.assertRegex(profile, r"(?i)declares `flowEntries`\s+without")
        self.assertRegex(profile, r"(?i)without declaring\s+`flowEntries`")
        # Terminals must bind the declared entries and stay untrusted.
        self.assertRegex(profile, r"(?i)exactly those declared entry steps")
        self.assertRegex(profile, r"(?i)untrusted data")
        # The submitted summary is deterministic and free of child output.
        self.assertIn("coordinate-issue completed", profile)
        self.assertRegex(profile, r"(?i)never include child output")
        # Safety envelope is preserved.
        self.assertIn("submit_task_result", profile)
        self.assertRegex(profile, r"(?i)stop and submit nothing")
        self.assertNotRegex(
            profile, r"workgraph/(?:create|assign|dispatch)_task"
        )
        self.assertNotRegex(profile, r"(?i)pull request")

    def test_linear_workflow_uses_only_default_lifecycle_profiles(self):
        for profile in (
            "issue-worker",
            "result-evaluator",
            "workflow-coordinator",
        ):
            self.assertIn(profile, self.workflow)
        for profile in set(EXPECTED_TOOLS) - {
            "issue-worker",
            "result-evaluator",
            "workflow-coordinator",
        }:
            self.assertNotIn(profile, self.workflow)
        self.assertRegex(
            self.workflow,
            r"(?m)^    evaluator: result-evaluator$",
        )
        self.assertRegex(
            self.workflow,
            r"(?m)^    orchestrator: workflow-coordinator$",
        )
        self.assertNotIn("agent:", self.workflow)
        self.assertEqual(self.workflow.count("worker: issue-worker"), 4)
        self.assertNotIn("worker: issue-validator", self.workflow)
        self.assertEqual(self.workflow.count("maxReworkAttempts: 3"), 1)
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
            "WorkGraphTaskAssignment/v1",
            "WorkGraphTaskDispatch/v1",
            "WorkGraphTaskResult/v1",
            "WorkGraphTaskEvaluation/v1",
            "WorkGraphTaskRoute/v1",
            "WorkGraphTaskError/v1",
        ):
            self.assertIn(marker, production)
        self.assertIn("Root Issue", production)
        self.assertIn("Root Task", production)
        self.assertNotRegex(production, r"WorkGraph[A-Za-z]*/v[23]")
        self.assertNotIn("WorkGraphTaskAssign/v1", production)
        self.assertNotIn("WorkGraphTaskEvaluate/v1", production)
        self.assertNotRegex(production, r"(?i)\bvnext\b")
        self.assertNotRegex(production, r"(?i)\bcompatibility\b")
        self.assertNotRegex(production, r"(?i)status:\s*new")
        self.assertNotRegex(production, r"(?i)admission[- ]bridge")
        self.assertNotRegex(production, r"(?i)\bdemo-[a-z0-9-]+\b")


if __name__ == "__main__":
    unittest.main()

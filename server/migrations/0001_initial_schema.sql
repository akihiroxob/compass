CREATE TABLE "workspace" ("id" text primary key, "name" text not null, "mission" text not null, "vision" text, "created_at" integer not null, "updated_at" integer not null, "status" text default 'active' not null check (status in ('active', 'archived')), "archived_at" integer, "archive_reason" text);

CREATE TABLE "workspace_principle" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "value" text not null, "sort_order" integer not null);

CREATE TABLE "workspace_constraint" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "value" text not null, "sort_order" integer not null);

CREATE TABLE "project" ("id" text primary key, "workspace_id" text not null references "workspace" ("id"), "name" text not null, "description" text, "created_at" integer not null, "updated_at" integer not null, "status" text default 'active' not null check (status in ('active', 'archived')), "archived_at" integer, "archive_reason" text);

CREATE TABLE "project_repository_link" ("id" text primary key, "project_id" text not null references "project" ("id") on delete cascade, "name" text not null, "url" text not null, "sort_order" integer not null, "required_checks" text default '[]' not null);

CREATE TABLE "project_resource" ("id" text primary key, "project_id" text not null references "project" ("id") on delete cascade, "name" text not null, "url" text not null, "kind" text, "sort_order" integer not null);

CREATE TABLE "intent" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "title" text not null, "desired_state" text not null, "background" text, "audience" text, "constraints" text, "completion_definition" text, "target_date" text, "status" text not null check (status in ('active', 'achieved', 'abandoned')), "abandoned_reason" text, "version" integer default 1 not null check (version >= 1), "meaning_version" integer default 1 not null check (meaning_version >= 1 and meaning_version <= version), "created_at" integer not null, "updated_at" integer not null, constraint "intent_id_workspace_unique" unique ("id", "workspace_id"));

CREATE TABLE "intent_revision" ("intent_id" text not null, "workspace_id" text not null, "version" integer not null check (version >= 1), "title" text not null, "desired_state" text not null, "background" text, "audience" text, "constraints" text, "completion_definition" text, "target_date" text, "meaning_changed" integer not null check (meaning_changed in (0, 1)), "reason" text, "changed_by" text not null, "changed_by_role" text not null, "created_at" integer not null, constraint "intent_revision_pk" primary key ("intent_id", "version"), constraint "intent_revision_intent_workspace_fk" foreign key ("intent_id", "workspace_id") references "intent" ("id", "workspace_id") on delete cascade);

CREATE TABLE "outcome" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "intent_id" text not null, "intent_version" integer not null check (intent_version >= 1), "title" text not null, "description" text not null, "hypothesis" text, "rationale" text not null, "status" text not null check (status in ('active', 'evaluating', 'achieved', 'not_achieved', 'cancelled')), "cancel_reason" text, "origin_decision_id" text, "revision" integer default 1 not null check (revision >= 1), "created_at" integer not null, "updated_at" integer not null, constraint "outcome_id_workspace_unique" unique ("id", "workspace_id"), constraint "outcome_id_intent_workspace_unique" unique ("id", "intent_id", "workspace_id"), constraint "outcome_intent_workspace_fk" foreign key ("intent_id", "workspace_id") references "intent" ("id", "workspace_id") on delete cascade);

CREATE TABLE "success_criterion" ("id" text primary key, "outcome_id" text not null references "outcome" ("id") on delete cascade, "position" integer not null, "description" text not null, "measurement" text not null, "target" text, "created_at" integer not null);

CREATE TABLE "outcome_problem" ("id" text primary key, "workspace_id" text not null, "outcome_id" text not null, "position" integer not null, "statement" text not null, "evidence_status" text not null check (evidence_status in ('insufficient', 'observed', 'refuted')), "observation" text, "cause_hypothesis" text, "solution_hypothesis" text, "evaluation_plan" text, "created_at" integer not null, "updated_at" integer not null, constraint "outcome_problem_id_workspace_unique" unique ("id", "workspace_id"), constraint "outcome_problem_outcome_workspace_fk" foreign key ("outcome_id", "workspace_id") references "outcome" ("id", "workspace_id") on delete cascade);

CREATE TABLE "outcome_problem_evidence" ("problem_id" text not null, "workspace_id" text not null, "position" integer not null, "finding_id" text, "synthesis_id" text, constraint "outcome_problem_evidence_problem_fk" foreign key ("problem_id", "workspace_id") references "outcome_problem" ("id", "workspace_id") on delete cascade, constraint "outcome_problem_evidence_finding_fk" foreign key ("finding_id", "workspace_id") references "research_finding" ("id", "workspace_id") on delete cascade, constraint "outcome_problem_evidence_synthesis_fk" foreign key ("synthesis_id", "workspace_id") references "research_synthesis" ("id", "workspace_id") on delete cascade, constraint "outcome_problem_evidence_pk" primary key ("problem_id", "position"), constraint "outcome_problem_evidence_one_ref" check ((finding_id is null) <> (synthesis_id is null)));

CREATE TABLE "outcome_target_project" ("outcome_id" text not null references "outcome" ("id") on delete cascade, "project_id" text not null references "project" ("id") on delete cascade, "created_at" integer not null, constraint "outcome_target_project_pk" primary key ("outcome_id", "project_id"));

CREATE TABLE "research_request" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "request_key" text not null, "input_hash" text not null, "kind" text not null check (kind in ('project_watch', 'decision')), "origin_intent_id" text, "origin_outcome_id" text, "question" text not null, "scope" text not null, "completion_condition" text not null, "budget_total" integer not null check (budget_total > 0), "budget_used" integer default 0 not null check (budget_used >= 0 and budget_used <= budget_total), "deadline_at" integer, "status" text not null check (status in ('requested', 'running', 'completed', 'insufficient', 'not_needed', 'cancelled')), "stop_reason" text, "correlation_id" text not null, "created_at" integer not null, "updated_at" integer not null, constraint "research_request_id_workspace_unique" unique ("id", "workspace_id"), constraint "research_origin_intent_workspace_fk" foreign key ("origin_intent_id", "workspace_id") references "intent" ("id", "workspace_id") on delete cascade, constraint "research_origin_outcome_workspace_fk" foreign key ("origin_outcome_id", "workspace_id") references "outcome" ("id", "workspace_id") on delete cascade, constraint "research_request_decision_has_intent" check (kind = 'project_watch' or origin_intent_id is not null));

CREATE TABLE "research_result" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "request_id" text not null, "sequence" integer not null, "request_key" text not null, "input_hash" text not null, "summary" text not null, "unknowns" text not null, "options" text not null, "risks" text not null, "budget_used" integer not null check (budget_used >= 0), "principal_id" text not null, "run_ref" text not null, "created_at" integer not null, constraint "research_result_id_workspace_unique" unique ("id", "workspace_id"), constraint "research_result_parent_workspace_fk" foreign key ("request_id", "workspace_id") references "research_request" ("id", "workspace_id") on delete cascade);

CREATE TABLE "research_evidence_ref" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "result_id" text not null, "position" integer not null, "kind" text not null check (kind in ('url', 'repository_file', 'issue', 'pull_request', 'ci', 'wacha_run')), "uri" text not null, "retrieved_at" integer not null, "version_hash" text, "resource_id" text references "project_resource" ("id") on delete set null, constraint "research_evidence_ref_id_workspace_unique" unique ("id", "workspace_id"), constraint "research_evidence_ref_parent_workspace_fk" foreign key ("result_id", "workspace_id") references "research_result" ("id", "workspace_id") on delete cascade);

CREATE TABLE "research_finding" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "request_id" text not null references "research_request" ("id") on delete cascade, "result_id" text not null, "position" integer not null, "statement" text not null, "confidence" text not null check (confidence in ('low', 'medium', 'high')), "observed_at" integer not null, "expires_at" integer, "principal_id" text not null, "run_ref" text not null, "created_at" integer not null, constraint "research_finding_id_workspace_unique" unique ("id", "workspace_id"), constraint "research_finding_parent_workspace_fk" foreign key ("result_id", "workspace_id") references "research_result" ("id", "workspace_id") on delete cascade);

CREATE TABLE "research_finding_evidence" ("finding_id" text not null references "research_finding" ("id") on delete cascade, "evidence_ref_id" text not null references "research_evidence_ref" ("id") on delete cascade, "position" integer not null, constraint "research_finding_evidence_pk" primary key ("finding_id", "evidence_ref_id"));

CREATE TABLE "research_finding_conflict" ("finding_id" text not null references "research_finding" ("id") on delete cascade, "conflicting_finding_id" text not null references "research_finding" ("id") on delete cascade, constraint "research_finding_conflict_pk" primary key ("finding_id", "conflicting_finding_id"));

CREATE TABLE "research_synthesis" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "request_id" text not null, "request_key" text not null, "input_hash" text not null, "version" integer not null check (version >= 1), "supersedes_id" text references "research_synthesis" ("id") on delete cascade, "conclusion" text not null, "risks" text not null, "options" text not null, "unknowns" text not null, "valid_as_of" integer not null, "principal_id" text not null, "run_ref" text not null, "created_at" integer not null, constraint "research_synthesis_id_workspace_unique" unique ("id", "workspace_id"), constraint "research_synthesis_parent_workspace_fk" foreign key ("request_id", "workspace_id") references "research_request" ("id", "workspace_id") on delete cascade);

CREATE TABLE "research_synthesis_finding" ("synthesis_id" text not null references "research_synthesis" ("id") on delete cascade, "finding_id" text not null references "research_finding" ("id") on delete cascade, "position" integer not null, constraint "research_synthesis_finding_pk" primary key ("synthesis_id", "finding_id"));

CREATE TABLE "direction_decision" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "intent_id" text not null, "outcome_id" text, "type" text not null check (type in ('next_outcome', 'additional_research', 'intent_complete', 'intent_abandon', 'policy_proposal', 'adr_candidate')), "judgment" text not null, "reason" text not null, "options" text not null, "intent_version" integer not null check (intent_version >= 1), "intent_brief_snapshot" text not null, "principal_id" text not null, "run_ref" text not null, "request_key" text not null, "input_hash" text not null, "evaluation_id" text references "outcome_evaluation" ("id"), "created_at" integer not null, constraint "decision_id_workspace_unique" unique ("id", "workspace_id"), constraint "decision_intent_workspace_fk" foreign key ("intent_id", "workspace_id") references "intent" ("id", "workspace_id") on delete cascade, constraint "decision_outcome_workspace_fk" foreign key ("outcome_id", "workspace_id") references "outcome" ("id", "workspace_id") on delete cascade, constraint "direction_decision_outcome_requires_next_outcome" check ((type = 'next_outcome') = (outcome_id is not null)));

CREATE TABLE "direction_decision_synthesis" ("decision_id" text not null references "direction_decision" ("id") on delete cascade, "synthesis_id" text not null references "research_synthesis" ("id") on delete cascade, "version" integer not null, "position" integer not null, constraint "direction_decision_synthesis_pk" primary key ("decision_id", "synthesis_id"));

CREATE TABLE "direction_decision_finding" ("decision_id" text not null references "direction_decision" ("id") on delete cascade, "finding_id" text not null references "research_finding" ("id") on delete cascade, "position" integer not null, constraint "direction_decision_finding_pk" primary key ("decision_id", "finding_id"));

CREATE TABLE "adr_handoff_request" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "project_id" text not null references "project" ("id") on delete cascade, "decision_id" text not null, "repository_id" text not null references "project_repository_link" ("id"), "correlation_id" text not null, "request_key" text not null, "input_hash" text not null, "payload" text not null, "principal_id" text not null, "created_at" integer not null, constraint "adr_decision_workspace_fk" foreign key ("decision_id", "workspace_id") references "direction_decision" ("id", "workspace_id"));

CREATE TABLE "adr_reference" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "project_id" text not null references "project" ("id") on delete cascade, "decision_id" text not null, "repository_id" text not null references "project_repository_link" ("id"), "path" text not null, "commit_sha" text not null, "pull_request_url" text, "correlation_id" text not null, "request_key" text not null, "input_hash" text not null, "principal_id" text not null, "created_at" integer not null, constraint "adr_decision_workspace_fk" foreign key ("decision_id", "workspace_id") references "direction_decision" ("id", "workspace_id"));

CREATE TABLE "runtime_event" ("sequence" integer primary key autoincrement, "id" text not null unique, "event_version" integer not null, "event_type" text not null check (event_type in ('research_requested', 'research_completed', 'outcome_confirmed', 'outcome_evaluated')), "workspace_id" text not null references "workspace" ("id") on delete cascade, "intent_id" text references "intent" ("id") on delete cascade, "research_request_id" text references "research_request" ("id") on delete cascade, "outcome_id" text references "outcome" ("id") on delete cascade, "evaluation_id" text references "outcome_evaluation" ("id") on delete cascade, "correlation_id" text not null, "conclusion" text check (conclusion is null or conclusion in ('completed', 'insufficient', 'not_needed')), "created_at" integer not null, constraint "runtime_event_sequence_workspace_unique" unique ("sequence", "workspace_id"), constraint "runtime_event_intent_workspace_fk" foreign key ("intent_id", "workspace_id") references "intent" ("id", "workspace_id"), constraint "runtime_event_request_workspace_fk" foreign key ("research_request_id", "workspace_id") references "research_request" ("id", "workspace_id"), constraint "runtime_event_outcome_workspace_fk" foreign key ("outcome_id", "workspace_id") references "outcome" ("id", "workspace_id"), constraint "runtime_event_evaluation_workspace_fk" foreign key ("evaluation_id", "workspace_id") references "outcome_evaluation" ("id", "workspace_id"), constraint "runtime_event_conclusion_matches_type" check ((event_type = 'research_completed') = (conclusion is not null)), constraint "runtime_event_subject_matches_type" check ((event_type in ('outcome_confirmed', 'outcome_evaluated')) = (outcome_id is not null) and (event_type in ('outcome_confirmed', 'outcome_evaluated')) = (research_request_id is null) and (event_type = 'outcome_evaluated') = (evaluation_id is not null)));

CREATE TABLE "runtime_event_delivery" ("consumer_id" text not null, "event_sequence" integer not null references "runtime_event" ("sequence") on delete cascade, "workspace_id" text not null references "workspace" ("id") on delete cascade, "outcome" text not null check (outcome in ('processed', 'retryable_failure', 'terminal_failure')), "retry_count" integer default 0 not null check (retry_count >= 0), "last_failure_reason" text, "created_at" integer not null, "updated_at" integer not null, constraint "runtime_event_delivery_workspace_fk" foreign key ("event_sequence", "workspace_id") references "runtime_event" ("sequence", "workspace_id"), constraint "runtime_event_delivery_pk" primary key ("consumer_id", "event_sequence"), constraint "runtime_event_delivery_failure_has_reason" check (outcome = 'processed' or last_failure_reason is not null));

CREATE TABLE "runtime_event_ack_attempt" ("consumer_id" text not null, "event_sequence" integer not null references "runtime_event" ("sequence") on delete cascade, "attempt_id" text not null, "workspace_id" text not null references "workspace" ("id") on delete cascade, "input_json" text not null, "result_json" text not null, "created_at" integer not null, constraint "runtime_event_ack_attempt_workspace_fk" foreign key ("event_sequence", "workspace_id") references "runtime_event" ("sequence", "workspace_id"), constraint "runtime_event_ack_attempt_pk" primary key ("consumer_id", "event_sequence", "attempt_id"));

CREATE TABLE "outcome_execution_summary" ("workspace_id" text not null references "workspace" ("id") on delete cascade, "project_id" text not null references "project" ("id") on delete cascade, "outcome_id" text not null references "outcome" ("id") on delete cascade, "correlation_id" text not null, "state" text not null check (state in ('accepted', 'rejected', 'canceled', 'incomplete')), "stories" text not null, "execution_cursor" integer not null check (execution_cursor >= 0), "observed_cursor" integer not null check (observed_cursor >= 0), "principal_id" text not null, "updated_at" integer not null, constraint "outcome_execution_summary_project_workspace_fk" foreign key ("project_id", "workspace_id") references "project" ("id", "workspace_id"), constraint "outcome_execution_summary_workspace_fk" foreign key ("outcome_id", "workspace_id") references "outcome" ("id", "workspace_id"), constraint "outcome_execution_summary_pk" primary key ("outcome_id", "project_id"));

CREATE TABLE "outcome_execution_evidence" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "project_id" text not null references "project" ("id") on delete cascade, "outcome_id" text not null references "outcome" ("id") on delete cascade, "kind" text not null check (kind in ('commit', 'pull_request', 'repository_file', 'ci', 'issue', 'url')), "uri" text not null, "version_hash" text, "observed_at" integer not null, "source_change_cursor" integer not null check (source_change_cursor >= 0), "principal_id" text not null, "created_at" integer not null, constraint "outcome_execution_evidence_project_workspace_fk" foreign key ("project_id", "workspace_id") references "project" ("id", "workspace_id"), constraint "outcome_execution_evidence_workspace_fk" foreign key ("outcome_id", "workspace_id") references "outcome" ("id", "workspace_id"));

CREATE TABLE "outcome_evaluation" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "outcome_id" text not null references "outcome" ("id") on delete cascade, "intent_id" text not null, "intent_version" integer not null check (intent_version >= 1), "result" text not null check (result in ('achieved', 'failed', 'insufficient_evidence')), "method" text not null, "target_version" text not null, "limitations" text not null, "problem_ids" text not null, "problem_plans" text not null, "criteria" text not null, "snapshot" text not null, "principal_id" text not null, "run_ref" text not null, "request_key" text not null, "input_hash" text not null, "created_at" integer not null, constraint "outcome_evaluation_id_workspace_unique" unique ("id", "workspace_id"), constraint "outcome_evaluation_outcome_workspace_fk" foreign key ("outcome_id", "workspace_id") references "outcome" ("id", "workspace_id"), constraint "outcome_evaluation_outcome_intent_fk" foreign key ("outcome_id", "intent_id", "workspace_id") references "outcome" ("id", "intent_id", "workspace_id"), constraint "outcome_evaluation_intent_workspace_fk" foreign key ("intent_id", "workspace_id") references "intent" ("id", "workspace_id"));

CREATE TABLE "intent_metric" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "intent_id" text not null, "key" text not null, "name" text not null, "unit" text not null, "target_value" real, "stale_after_days" integer not null check (stale_after_days between 1 and 366), "revision" integer not null check (revision >= 1), "created_by_principal_id" text not null, "created_at" integer not null, "updated_at" integer not null, constraint "intent_metric_intent_workspace_fk" foreign key ("intent_id", "workspace_id") references "intent" ("id", "workspace_id") on delete cascade, constraint "intent_metric_intent_key_unique" unique ("intent_id", "key"));

CREATE TABLE "intent_metric_observation" ("id" text primary key, "metric_id" text not null references "intent_metric" ("id") on delete cascade, "period_start" text not null, "period_end" text not null, "revision" integer not null check (revision >= 1), "status" text not null check (status in ('observed', 'failed')), "value" real, "failure_reason" text, "source_name" text not null, "source_uri" text, "observed_at" integer not null, "principal_id" text not null, "recorded_at" integer not null, constraint "intent_metric_observation_value_check" check ((status = 'observed' and value is not null and failure_reason is null) or (status = 'failed' and value is null and failure_reason is not null)), constraint "intent_metric_observation_period_check" check (period_start <= period_end), constraint "intent_metric_observation_revision_unique" unique ("metric_id", "period_start", "period_end", "revision"));

CREATE TABLE "intent_explanation" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "intent_id" text not null, "metric_key" text not null, "period_start" text not null, "period_end" text not null, "version" integer not null check (version >= 1), "previous_id" text references "intent_explanation" ("id"), "change_from_previous" text, "principal_id" text not null, "run_ref" text not null, "request_key" text not null, "input_hash" text not null, "created_at" integer not null, constraint "intent_explanation_id_workspace_unique" unique ("id", "workspace_id"), constraint "intent_explanation_intent_workspace_fk" foreign key ("intent_id", "workspace_id") references "intent" ("id", "workspace_id") on delete cascade, constraint "intent_explanation_version_unique" unique ("intent_id", "metric_key", "version"), constraint "intent_explanation_request_key_unique" unique ("workspace_id", "request_key"), constraint "intent_explanation_period_check" check (period_start <= period_end), constraint "intent_explanation_previous_check" check ((version = 1) = (previous_id is null)));

CREATE TABLE "intent_explanation_item" ("explanation_id" text not null references "intent_explanation" ("id") on delete cascade, "position" integer not null check (position >= 0), "kind" text not null check (kind in ('fact', 'hypothesis', 'proposal')), "statement" text not null, "confidence" text check (confidence in ('low', 'medium', 'high')), "verification" text, "based_on" text not null, constraint "intent_explanation_item_pk" primary key ("explanation_id", "position"), constraint "intent_explanation_item_hypothesis_check" check ((kind = 'hypothesis' and confidence is not null and verification is not null) or (kind <> 'hypothesis' and confidence is null and verification is null)));

CREATE TABLE "intent_explanation_basis" ("explanation_id" text not null, "workspace_id" text not null, "item_position" integer not null, "position" integer not null, "observation_id" text references "intent_metric_observation" ("id") on delete cascade, "finding_id" text, "synthesis_id" text, "evaluation_id" text, "decision_id" text, constraint "intent_explanation_basis_explanation_fk" foreign key ("explanation_id", "workspace_id") references "intent_explanation" ("id", "workspace_id") on delete cascade, constraint "intent_explanation_basis_finding_fk" foreign key ("finding_id", "workspace_id") references "research_finding" ("id", "workspace_id") on delete cascade, constraint "intent_explanation_basis_synthesis_fk" foreign key ("synthesis_id", "workspace_id") references "research_synthesis" ("id", "workspace_id") on delete cascade, constraint "intent_explanation_basis_evaluation_fk" foreign key ("evaluation_id", "workspace_id") references "outcome_evaluation" ("id", "workspace_id") on delete cascade, constraint "intent_explanation_basis_decision_fk" foreign key ("decision_id", "workspace_id") references "direction_decision" ("id", "workspace_id") on delete cascade, constraint "intent_explanation_basis_pk" primary key ("explanation_id", "item_position", "position"), constraint "intent_explanation_basis_one_ref" check ((observation_id is not null) + (finding_id is not null) + (synthesis_id is not null) + (evaluation_id is not null) + (decision_id is not null) = 1));

CREATE TABLE "intent_explanation_outcome" ("explanation_id" text not null, "workspace_id" text not null, "outcome_id" text not null, "position" integer not null, constraint "intent_explanation_outcome_explanation_fk" foreign key ("explanation_id", "workspace_id") references "intent_explanation" ("id", "workspace_id") on delete cascade, constraint "intent_explanation_outcome_outcome_fk" foreign key ("outcome_id", "workspace_id") references "outcome" ("id", "workspace_id") on delete cascade, constraint "intent_explanation_outcome_pk" primary key ("explanation_id", "position"));

CREATE TABLE "story" ("id" text primary key, "project_id" text not null references "project" ("id") on delete cascade, "title" text not null, "description" text, "status" text not null check (status in ('todo', 'doing', 'done', 'canceled')), "sort_order" integer default 0 not null, "created_at" integer not null, "updated_at" integer not null, "outcome_ref" text, "origin_decision_id" text, "success_criteria_snapshot" text, "constraints_snapshot" text, "repository_snapshot" text, "correlation_id" text);

CREATE TABLE "task" ("id" text primary key, "project_id" text not null references "project" ("id") on delete cascade, "story_id" text references "story" ("id"), "title" text not null, "description" text, "status" text not null, "assignee" text, "reject_reason" text, "resume_source_status" text, "sort_order" integer default 0 not null, "created_at" integer not null, "updated_at" integer not null, "task_key" text);

CREATE TABLE "task_consultation_wait" ("task_id" text primary key references "task" ("id") on delete cascade, "project_id" text not null references "project" ("id") on delete cascade, "principal_id" text not null, "role" text not null check (role in ('worker','reviewer','manager')), "phase" text not null check (phase in ('work','review','acceptance')), "consultations" text not null, "requirement_version" text not null, "runtime" text not null, "state" text not null check (state in ('waiting','ready','resuming')), "failure_reason" text, "created_at" integer not null, "updated_at" integer not null);

CREATE TABLE "task_comment" ("id" text primary key, "task_id" text not null references "task" ("id"), "body" text not null, "author" text, "principal_id" text, "claim_id" text, "created_at" integer not null);

CREATE TABLE "task_claim" ("id" text primary key, "task_id" text not null references "task" ("id") on delete cascade, "principal_id" text not null, "state" text not null, "acquired_at" integer not null, "renewed_at" integer, "expires_at" integer not null, "released_at" integer, "release_reason" text);

CREATE TABLE "task_pull_request" ("id" text primary key, "task_id" text not null references "task" ("id") on delete cascade, "project_id" text not null references "project" ("id") on delete cascade, "repository_id" text not null, "repository" text not null, "number" integer not null, "sequence" integer not null, "url" text not null, "state" text not null check (state in ('open','closed','merged')), "draft" integer not null, "head_branch" text not null, "head_sha" text not null, "base_branch" text not null, "merge_sha" text, "author" text not null, "work_claim_id" text not null, "principal_id" text not null, "verified_at" integer not null, "reviewed_head_sha" text, "review_comment_id" integer, "review_comment_url" text, "accepted_merge_sha" text, "acceptance_evidence" text, "created_at" integer not null, "updated_at" integer not null, constraint "task_pull_request_repository_number_unique" unique ("repository", "number"), constraint "task_pull_request_task_sequence_unique" unique ("task_id", "sequence"));

CREATE TABLE "publication_record" ("id" text primary key, "project_id" text not null references "project" ("id") on delete cascade, "repository_id" text not null, "target" text not null, "target_url" text, "revision" text not null, "method" text, "evidence" text not null, "observed_at" integer not null, "received_at" integer not null, "sequence" integer not null, "principal_id" text not null, constraint "publication_record_sequence_unique" unique ("project_id", "sequence"), constraint "publication_record_observation_unique" unique ("project_id", "repository_id", "target", "revision", "observed_at"));

CREATE TABLE "publication_revision" ("publication_id" text not null references "publication_record" ("id") on delete cascade, "commit_sha" text not null, "relation" text not null check (relation in ('included','not_included')), constraint "publication_revision_pk" primary key ("publication_id", "commit_sha"));

CREATE TABLE "change_log" ("cursor" integer primary key autoincrement, "project_id" text not null references "project" ("id") on delete cascade, "type" text not null, "entity_id" text not null, "principal_id" text not null, "claim_id" text, "payload" text not null, "occurred_at" integer not null);

CREATE TABLE "command_receipt" ("principal_id" text not null, "tool_name" text not null, "request_id" text not null, "input_json" text not null, "result_json" text not null, "active_role" text, "created_at" integer not null, constraint "command_receipt_pk" primary key ("principal_id", "tool_name", "request_id"));

CREATE TABLE "project_grant" ("project_id" text not null references "project" ("id") on delete cascade, "principal_id" text not null, "role" text not null, "created_at" integer not null, constraint "project_grant_pk" primary key ("project_id", "principal_id", "role"));

CREATE TABLE "workspace_grant" ("workspace_id" text not null references "workspace" ("id") on delete cascade, "principal_id" text not null, "role" text not null check (role in ('strategist', 'researcher', 'evaluator')), "created_at" integer not null, constraint "workspace_grant_pk" primary key ("workspace_id", "principal_id", "role"));

CREATE TABLE "human_user" ("id" text primary key, "display_name" text not null, "email" text not null, "platform_role" text not null check (platform_role in ('owner', 'member')), "status" text not null check (status in ('active', 'disabled')), "created_at" integer not null, "updated_at" integer not null);

CREATE TABLE "human_identity" ("id" text primary key, "human_user_id" text not null references "human_user" ("id"), "provider" text not null check (provider in ('google', 'local')), "issuer" text not null, "subject" text not null, "email_at_login" text not null, "created_at" integer not null, "last_login_at" integer not null);

CREATE TABLE "web_session" ("id" text primary key, "token_hash" text not null unique, "human_user_id" text not null references "human_user" ("id"), "created_at" integer not null, "last_seen_at" integer not null, "expires_at" integer not null, "revoked_at" integer, "revoke_reason" text check (revoke_reason in ('logout', 'human_disabled', 'superseded')));

CREATE TABLE "auth_login_attempt" ("id" text primary key, "provider" text not null check (provider in ('google', 'local')), "state" text, "nonce" text, "code_verifier" text, "return_to" text not null, "invitation_token_hash" text, "created_at" integer not null, "expires_at" integer not null, "consumed_at" integer);

CREATE TABLE "workspace_invitation" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "email" text not null, "role" text not null check (role in ('owner', 'administrator', 'editor', 'viewer')), "token_hash" text not null unique, "status" text not null check (status in ('pending', 'accepted', 'revoked')), "expires_at" integer not null, "created_by_human_user_id" text not null references "human_user" ("id"), "created_at" integer not null, "accepted_by_human_user_id" text references "human_user" ("id"), "accepted_at" integer, "revoked_by_human_user_id" text references "human_user" ("id"), "revoked_at" integer);

CREATE TABLE "workspace_membership" ("id" text primary key, "workspace_id" text not null references "workspace" ("id") on delete cascade, "human_user_id" text not null references "human_user" ("id"), "role" text not null check (role in ('owner', 'administrator', 'editor', 'viewer')), "created_at" integer not null, "updated_at" integer not null, "created_by_human_user_id" text references "human_user" ("id"), "revoked_at" integer, "revoked_by_human_user_id" text references "human_user" ("id"));

CREATE TABLE "access_credential" ("id" text primary key, "scope_kind" text not null check (scope_kind in ('workspace', 'project')), "workspace_id" text references "workspace" ("id") on delete cascade, "project_id" text references "project" ("id") on delete cascade, "kind" text not null check (kind in ('agent', 'runtime')), "principal_id" text not null, "scopes_json" text not null, "prefix" text not null, "secret_hash" text not null unique, "expires_at" integer not null, "revoked_at" integer, "revoked_by_human_user_id" text references "human_user" ("id"), "last_used_at" integer, "created_at" integer not null, "created_by_human_user_id" text not null references "human_user" ("id"), "rotated_from_id" text references "access_credential" ("id"), constraint "access_credential_scope_check" check ((scope_kind = 'workspace' and workspace_id is not null and project_id is null)
        or (scope_kind = 'project' and project_id is not null and workspace_id is null)));

CREATE TABLE "agent_run" ("run_id" text primary key, "scope_kind" text not null check (scope_kind in ('workspace', 'project')), "scope_id" text not null, "principal_id" text not null, "role" text not null, "source" text not null check (source in ('ralph', 'orchestrator')), "provider" text, "work_kind" text, "work_id" text, "reporter_kind" text not null check (reporter_kind in ('agent', 'runtime')), "reporter_principal_id" text not null, "status" text not null check (status in ('running', 'succeeded', 'failed')), "started_at" integer not null, "observed_at" integer not null, "stale_at" integer not null, "ended_at" integer, "reason" text, constraint "agent_run_work_ref" check ((work_kind is null) = (work_id is null)), constraint "agent_run_ended" check ((status = 'running') = (ended_at is null)));

CREATE TABLE "activity" ("cursor" integer primary key autoincrement, "id" text not null unique, "scope" text not null check (scope in ('project', 'workspace', 'system')), "workspace_id" text references "workspace" ("id"), "project_id" text references "project" ("id") on delete cascade, "type" text not null, "principal_id" text not null, "role" text not null, "summary" text not null check (length(trim(summary)) > 0), "body" text, "refs" text default '[]' not null, "corrects_activity_id" text references "activity" ("id"), "source" text not null check (source in ('recorded', 'canonical')), "dedupe_key" text not null unique, "input_hash" text, "occurred_at" integer not null, "recorded_at" integer not null, constraint "activity_scope_ids_check" check ((scope = 'project' and workspace_id is not null and project_id is not null)
        or (scope = 'workspace' and workspace_id is not null and project_id is null)
        or (scope = 'system' and workspace_id is null and project_id is null)));

CREATE TABLE "consultation" ("id" text primary key, "scope" text not null check (scope in ('project', 'workspace')), "workspace_id" text not null references "workspace" ("id"), "project_id" text references "project" ("id") on delete cascade, "title" text not null, "question" text not null, "blocking_reason" text not null, "options" text default '[]' not null, "recommendation" text not null, "impact" text not null, "due_at" integer, "refs" text default '[]' not null, "status" text not null check (status in ('waiting_human', 'waiting_agent', 'resolved', 'canceled')), "revision" integer not null check (revision >= 1), "supersedes_consultation_id" text references "consultation" ("id"), "created_by_kind" text not null check (created_by_kind in ('human', 'agent')), "created_by_principal_id" text not null, "created_by_role" text not null, "created_at" integer not null, "updated_at" integer not null, "cancel_reason" text, "canceled_by_kind" text check (canceled_by_kind in ('human', 'agent')), "canceled_by_principal_id" text, "canceled_by_role" text, "canceled_at" integer, constraint "consultation_scope_check" check ((scope = 'project') = (project_id is not null)), constraint "consultation_cancel_check" check ((status = 'canceled') = (cancel_reason is not null and canceled_by_kind is not null and canceled_by_principal_id is not null and canceled_at is not null)));

CREATE TABLE "consultation_message" ("id" text primary key, "consultation_id" text not null references "consultation" ("id") on delete cascade, "sequence" integer not null check (sequence >= 1), "author_kind" text not null check (author_kind in ('human', 'agent')), "principal_id" text not null, "role" text not null, "body" text not null check (length(trim(body)) > 0), "corrects_message_id" text references "consultation_message" ("id"), "revision" integer not null, "created_at" integer not null, constraint "consultation_message_sequence_unique" unique ("consultation_id", "sequence"));

CREATE TABLE "consultation_resolution" ("id" text primary key, "consultation_id" text not null unique references "consultation" ("id") on delete cascade, "source" text not null check (source in ('human_decision', 'agent_summary')), "conclusion" text not null, "rationale" text not null, "applicability" text, "selected_option" integer, "basis_message_ids" text default '[]' not null, "basis_revision" integer not null, "recorded_by_kind" text not null check (recorded_by_kind in ('human', 'agent')), "recorded_by_principal_id" text not null, "recorded_by_role" text not null, "created_at" integer not null, constraint "consultation_resolution_source_check" check ((source = 'human_decision' and recorded_by_kind = 'human') or (source = 'agent_summary' and recorded_by_kind = 'agent')));

CREATE TABLE "consultation_lease" ("id" text primary key, "consultation_id" text not null references "consultation" ("id") on delete cascade, "input_revision" integer not null, "principal_id" text not null, "role" text not null, "acquired_at" integer not null, "expires_at" integer not null, "released_at" integer);

CREATE TABLE "consultation_command_receipt" ("principal_id" text not null, "operation" text not null, "request_id" text not null, "input_hash" text not null, "result_json" text not null, "created_at" integer not null, constraint "consultation_command_receipt_pk" primary key ("principal_id", "operation", "request_id"));

CREATE TABLE "consultation_followup" ("id" text primary key, "consultation_id" text not null references "consultation" ("id") on delete cascade, "resolution_id" text not null references "consultation_resolution" ("id") on delete cascade, "kind" text not null check (kind in ('adr', 'specification', 'policy')), "project_id" text not null references "project" ("id") on delete cascade, "repository_id" text not null, "task_id" text not null unique references "task" ("id") on delete cascade, "title" text not null, "purpose" text not null, "decision" text not null, "rationale" text not null, "verification" text not null, "resumption_dependency" text, "requested_by_principal_id" text not null, "requested_by_role" text not null, "created_at" integer not null, constraint "consultation_followup_target_unique" unique ("consultation_id", "kind", "project_id", "repository_id"));

CREATE TABLE "consultation_handoff" ("consultation_id" text not null references "consultation" ("id") on delete cascade, "project_id" text not null references "project" ("id") on delete cascade, "handed_off_by_principal_id" text not null, "handed_off_by_role" text not null, "created_at" integer not null, constraint "consultation_handoff_pk" primary key ("consultation_id", "project_id"));

CREATE TABLE "consultation_artifact" ("id" text primary key, "followup_id" text not null references "consultation_followup" ("id") on delete cascade, "consultation_id" text not null references "consultation" ("id") on delete cascade, "task_id" text not null, "repository_id" text not null, "path" text not null, "commit_sha" text not null check (length(commit_sha) = 40), "pull_request_url" text, "recorded_by_principal_id" text not null, "recorded_by_role" text not null, "created_at" integer not null, constraint "consultation_artifact_unique" unique ("followup_id", "path", "commit_sha"));

CREATE UNIQUE INDEX "project_id_workspace_idx" on "project" ("id", "workspace_id");

CREATE INDEX "intent_workspace_id_idx" on "intent" ("workspace_id");

CREATE INDEX "outcome_intent_id_created_at_idx" on "outcome" ("intent_id", "created_at");

CREATE UNIQUE INDEX "success_criterion_outcome_id_position_idx" on "success_criterion" ("outcome_id", "position");

CREATE UNIQUE INDEX "outcome_problem_outcome_position_idx" on "outcome_problem" ("outcome_id", "position");

CREATE INDEX "outcome_target_project_project_idx" on "outcome_target_project" ("project_id");

CREATE UNIQUE INDEX "research_request_workspace_key_idx" on "research_request" ("workspace_id", "request_key");

CREATE INDEX "research_request_origin_intent_idx" on "research_request" ("workspace_id", "origin_intent_id");

CREATE UNIQUE INDEX "research_result_request_sequence_idx" on "research_result" ("request_id", "sequence");

CREATE UNIQUE INDEX "research_result_request_key_idx" on "research_result" ("request_id", "request_key");

CREATE UNIQUE INDEX "research_evidence_ref_result_position_idx" on "research_evidence_ref" ("result_id", "position");

CREATE UNIQUE INDEX "research_finding_result_position_idx" on "research_finding" ("result_id", "position");

CREATE INDEX "research_finding_workspace_idx" on "research_finding" ("workspace_id");

CREATE UNIQUE INDEX "research_synthesis_request_key_idx" on "research_synthesis" ("request_id", "request_key");

CREATE UNIQUE INDEX research_synthesis_supersedes_idx
    on research_synthesis (supersedes_id) where supersedes_id is not null;

CREATE INDEX "research_synthesis_workspace_idx" on "research_synthesis" ("workspace_id");

CREATE UNIQUE INDEX "direction_decision_workspace_key_idx" on "direction_decision" ("workspace_id", "request_key");

CREATE INDEX "direction_decision_intent_idx" on "direction_decision" ("workspace_id", "intent_id");

CREATE UNIQUE INDEX direction_decision_evaluation_idx
    on direction_decision (evaluation_id) where evaluation_id is not null;

CREATE UNIQUE INDEX "adr_handoff_request_workspace_key_idx" on "adr_handoff_request" ("workspace_id", "request_key");

CREATE INDEX "adr_handoff_request_decision_repo_correlation_idx" on "adr_handoff_request" ("decision_id", "repository_id", "correlation_id");

CREATE UNIQUE INDEX "adr_reference_workspace_key_idx" on "adr_reference" ("workspace_id", "request_key");

CREATE INDEX "adr_reference_workspace_created_idx" on "adr_reference" ("workspace_id", "created_at");

CREATE UNIQUE INDEX "runtime_event_request_type_idx" on "runtime_event" ("research_request_id", "event_type");

CREATE UNIQUE INDEX runtime_event_outcome_confirmed_idx
    on runtime_event (outcome_id) where event_type = 'outcome_confirmed';

CREATE UNIQUE INDEX "runtime_event_evaluation_idx" on "runtime_event" ("evaluation_id");

CREATE INDEX "runtime_event_workspace_sequence_idx" on "runtime_event" ("workspace_id", "sequence");

CREATE UNIQUE INDEX outcome_execution_evidence_identity_idx on outcome_execution_evidence(outcome_id, project_id, kind, uri, ifnull(version_hash, ''));

CREATE INDEX "outcome_execution_evidence_outcome_idx" on "outcome_execution_evidence" ("outcome_id", "created_at");

CREATE UNIQUE INDEX "outcome_evaluation_workspace_key_idx" on "outcome_evaluation" ("workspace_id", "request_key");

CREATE INDEX "outcome_evaluation_outcome_idx" on "outcome_evaluation" ("outcome_id", "created_at");

CREATE INDEX "intent_metric_observation_metric_period_idx" on "intent_metric_observation" ("metric_id", "period_end", "period_start");

CREATE INDEX "intent_explanation_intent_idx" on "intent_explanation" ("intent_id", "created_at");

CREATE INDEX "story_project_idx" on "story" ("project_id");

CREATE UNIQUE INDEX "story_project_correlation_idx" on "story" ("project_id", "correlation_id");

CREATE INDEX "task_project_idx" on "task" ("project_id");

CREATE INDEX "task_story_idx" on "task" ("story_id");

CREATE UNIQUE INDEX task_story_key_idx on task(story_id, task_key) where task_key is not null;

CREATE INDEX "task_comment_task_idx" on "task_comment" ("task_id");

CREATE INDEX "task_claim_task_state_idx" on "task_claim" ("task_id", "state");

CREATE UNIQUE INDEX task_claim_active_task_idx on task_claim(task_id) where state = 'active';

CREATE INDEX "change_log_project_cursor_idx" on "change_log" ("project_id", "cursor");

CREATE INDEX "change_log_entity_type_idx" on "change_log" ("entity_id", "type");

CREATE INDEX "project_grant_principal_id_project_id_idx" on "project_grant" ("principal_id", "project_id");

CREATE INDEX "workspace_grant_principal_idx" on "workspace_grant" ("principal_id", "workspace_id");

CREATE UNIQUE INDEX human_user_platform_owner_idx
    on human_user (platform_role) where platform_role = 'owner';

CREATE UNIQUE INDEX "human_identity_provider_subject_idx" on "human_identity" ("provider", "issuer", "subject");

CREATE UNIQUE INDEX "human_identity_human_provider_idx" on "human_identity" ("human_user_id", "provider");

CREATE INDEX "web_session_human_idx" on "web_session" ("human_user_id");

CREATE UNIQUE INDEX workspace_invitation_pending_idx
    on workspace_invitation (workspace_id, email) where status = 'pending';

CREATE UNIQUE INDEX workspace_membership_active_idx
    on workspace_membership (workspace_id, human_user_id) where revoked_at is null;

CREATE INDEX "workspace_membership_human_idx" on "workspace_membership" ("human_user_id");

CREATE INDEX "access_credential_project_idx" on "access_credential" ("project_id");

CREATE INDEX "access_credential_workspace_idx" on "access_credential" ("workspace_id");

CREATE INDEX "access_credential_principal_idx" on "access_credential" ("kind", "principal_id");

CREATE INDEX "agent_run_scope_principal_idx" on "agent_run" ("scope_kind", "scope_id", "principal_id", "started_at");

CREATE INDEX "activity_project_cursor_idx" on "activity" ("project_id", "cursor");

CREATE INDEX "activity_workspace_cursor_idx" on "activity" ("scope", "workspace_id", "cursor");

CREATE INDEX "activity_workspace_stream_idx" on "activity" ("workspace_id", "occurred_at", "cursor");

CREATE INDEX "activity_corrects_idx" on "activity" ("corrects_activity_id");

CREATE INDEX "consultation_project_updated_idx" on "consultation" ("project_id", "status", "updated_at");

CREATE INDEX "consultation_workspace_updated_idx" on "consultation" ("workspace_id", "scope", "status", "updated_at");

CREATE INDEX "consultation_lease_consultation_idx" on "consultation_lease" ("consultation_id", "input_revision");

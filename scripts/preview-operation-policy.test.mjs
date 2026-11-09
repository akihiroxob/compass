import { test } from 'node:test';
import assert from 'node:assert/strict';
import { policyDenial, previewOperationPolicy } from './preview-operation-policy.mjs';

const preparation = { operationPolicy: previewOperationPolicy, actors: { strategist: 'fixture-strategist', reviewer: 'fixture-reviewer' },
  workspaceIds: ['workspace'], projectIds: ['project'] };
const args = { workspaceId: 'workspace', projectId: 'project', outcomeId: 'outcome' };
const known = new Set(['outcome']);
test('Target operations are scoped to the dedicated Strategist and observed Entities', () => {
  for (const name of ['set_outcome_target', 'list_outcome_targets']) {
    const tool = { name };
    assert.equal(policyDenial(preparation, 'strategist', tool, args, known), null);
    assert.ok(policyDenial(preparation, 'reviewer', tool, args, known));
    assert.ok(policyDenial(preparation, 'strategist', tool, { ...args, workspaceId: 'other' }, known));
    assert.ok(policyDenial(preparation, 'strategist', tool, { ...args, projectId: 'other' }, known));
    assert.ok(policyDenial(preparation, 'strategist', tool, args, new Set()));
    assert.ok(policyDenial(preparation, 'strategist', { name, _meta: { 'compass/caller': 'runtime' } }, args, known));
  }
});
test('Direction exception does not open other unclassified or Human management tools', () => {
  for (const name of ['create_outcome', 'unset_outcome_target', 'grant_workspace_role', 'issue_agent_credential']) {
    assert.ok(policyDenial(preparation, 'strategist', { name }, args, known));
  }
  assert.ok(policyDenial(preparation, 'strategist', { name: 'set_outcome_target' }, {}, known));
});

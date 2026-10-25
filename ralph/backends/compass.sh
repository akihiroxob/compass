#!/usr/bin/env bash
# shellcheck shell=bash
# Compass Serverの`/mcp`（Streamable HTTP・stateless）を呼び出す。

COMPASS_MCP_URL="$COMPASS_SERVER_URL/mcp"

backend_requirements() {
  require_command curl
}

# tokenをcurlの引数（process一覧から見える）に置かないよう、header fileで渡す。
# 操作Contextは`X-Compass-Active-Role`で起動するRoleに固定する。
backend_set_identity() {
  printf 'Authorization: Bearer %s\nX-Compass-Active-Role: %s\n' \
    "$RALPH_ROLE_TOKEN" "$RALPH_ACTIVE_ROLE" >"$RALPH_TMP_DIR/headers"
}

normalize_mcp_response() {
  local response="$1"

  if printf '%s' "$response" | jq -e . >/dev/null 2>&1; then
    printf '%s\n' "$response"
    return
  fi

  # Streamable HTTPがSSEで返した場合は、最後のJSON data行を使う。
  printf '%s\n' "$response" | sed -n 's/^data: //p' | tail -n 1
}

mcp_call() {
  local tool_name="$1"
  local arguments_json="$2"
  local request raw response

  request="$(jq -cn \
    --arg name "$tool_name" \
    --argjson arguments "$arguments_json" \
    '{jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: $name, arguments: $arguments}}')"
  raw="$(curl --silent --show-error --fail-with-body --request POST "$COMPASS_MCP_URL" \
    --header 'Accept: application/json, text/event-stream' \
    --header 'Content-Type: application/json' \
    --header "@$RALPH_TMP_DIR/headers" \
    --data "$request")" || {
    ralph_log_error 'Compass MCP呼び出しに失敗しました (%s): %s\n' "$tool_name" "$raw"
    return 1
  }
  response="$(normalize_mcp_response "$raw")"
  jq -e '.result and (.error | not) and (.result.isError != true)' >/dev/null 2>&1 <<<"$response" || {
    ralph_log_error 'Compass MCP呼び出しに失敗しました (%s): %s\n' "$tool_name" "$response"
    return 1
  }
  printf '%s\n' "$response"
}

backend_get_task_summary() {
  local role="$1"
  local availability tasks resumptions
  case "$role" in
    worker) availability="work" ;;
    reviewer) availability="review" ;;
    manager) availability="acceptance" ;;
  esac
  tasks="$(mcp_call 'list_tasks' "$(jq -cn \
    --arg project_id "$COMPASS_PROJECT_ID" \
    --arg availability "$availability" \
    '{projectId: $project_id, filter: {availableFor: $availability}}')")" || return 1
  resumptions="$(mcp_call 'list_consultation_resumptions' "$(jq -cn --arg project_id "$COMPASS_PROJECT_ID" '{projectId: $project_id}')")" || return 1
  jq -e --arg root "$PROJECT_ROOT" --argjson resumptions "$(jq '.result.structuredContent.resumptions // []' <<<"$resumptions")" '($resumptions | map(select(.runtime.worktreePath == $root))) as $resumptions | {
    resumptions: $resumptions,
    readyCount: ($resumptions | map(select(.state == "ready")) | length),
    byStatus: .result.structuredContent.summary.byStatus,
    availableCount: (((.result.structuredContent.tasks // []) | length) + ($resumptions | map(select(.state == "ready")) | length)),
    availableRejected: ((.result.structuredContent.tasks // []) | map(select(.status == "rejected")) | length)
  }' <<<"$tasks"
}

backend_format_status() {
  local role="$1"
  local summary="$2"
  if [[ "$role" == worker ]]; then
    jq -r '"Worker対象: todo=\(.byStatus.todo // 0) rejected=\(.byStatus.rejected // 0) doing=\(.byStatus.doing // 0) available=\(.availableCount // 0)"' <<<"$summary"
  elif [[ "$role" == reviewer ]]; then
    jq -r '"Reviewer対象: in_review=\(.byStatus.in_review // 0) available=\(.availableCount // 0)"' <<<"$summary"
  else
    jq -r '"Manager対象: wait_accept=\(.byStatus.wait_accept // 0) available=\(.availableCount // 0)"' <<<"$summary"
  fi
}

backend_print_status() {
  local role="$1"
  local summary="$2"
  local status
  status="$(backend_format_status "$role" "$summary")"
  ralph_log '%s\n' "$status"
}

backend_pending_count() {
  local role="$1"
  local summary="$2"
  : "$role"
  jq -r '.availableCount // 0' <<<"$summary"
}

# 呼出側はworktree lockを保持してからproviderを起動する。再開Claimは実際の成果物照合後に取得する。
backend_prepare_consultation_resumption() {
  local summary="$1"
  local saved actual response task_id
  RALPH_EXECUTION_ROOT="$PROJECT_ROOT"
  saved="$(jq -c '[.resumptions[]? | select(.state == "ready")][0] // empty' <<<"$summary")"
  [[ -n "$saved" ]] || return 0
  task_id="$(jq -r '.taskId' <<<"$saved")"
  jq '.runtime' <<<"$saved" >"$RALPH_TMP_DIR/resumption-runtime.json"
  if ! actual="$(node "$RALPH_ROOT/runtime/consultation-context.mjs" "$RALPH_TMP_DIR/resumption-runtime.json")"; then
    (( $(jq '.availableCount - .readyCount' <<<"$summary") > 0 )) && return 0
    return 1
  fi
  response="$(mcp_call 'resume_consultation_task' "$(jq -cn --arg taskId "$task_id" --argjson runtime "$actual" \
    --arg requestId "resume-$task_id-$(date +%s)-$$" '{taskId: $taskId, runtime: $runtime, requestId: $requestId}')")" || {
    # このTaskの再開失敗で、同じRoleの別Taskまで止めない。
    (( $(jq '.availableCount - .readyCount' <<<"$summary") > 0 )) && return 0
    return 1
  }
  RALPH_EXECUTION_ROOT="$(jq -r '.worktreePath' <<<"$actual")"
  printf '\n相談からの再開Context（Claim取得済み。Taskを選択・Claimし直さない）:\n' >>"$rendered_prompt"
  jq '.result.structuredContent' <<<"$response" >>"$rendered_prompt"
  printf '\n保存済みContextを読み、全相談の現在の結論・現在のTask要件・PR/SHAと照合して再判断する。旧blocked結果を再送しない。保存済み検証を変更後のSHAに流用しない。\n' >>"$rendered_prompt"
}

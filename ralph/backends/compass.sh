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
  [[ "$(jq '[.resumptions[]? | select(.state == "ready")] | length' <<<"$summary")" -gt 0 ]] || return 0
  while IFS= read -r saved; do
    task_id="$(jq -r '.taskId' <<<"$saved")"
    jq '.runtime' <<<"$saved" >"$RALPH_TMP_DIR/resumption-runtime.json"
    if ! actual="$(node "$RALPH_ROOT/runtime/consultation-context.mjs" "$RALPH_TMP_DIR/resumption-runtime.json")"; then
      ralph_log_error 'Task %sの相談再開に失敗しました（保存済みContext/成果物の読込）。次の候補を確認します。\n' "$task_id"
      continue
    fi
    if ! response="$(mcp_call 'resume_consultation_task' "$(jq -cn --arg taskId "$task_id" --argjson runtime "$actual" \
      --arg requestId "resume-$task_id-$(date +%s)-$$" '{taskId: $taskId, runtime: $runtime, requestId: $requestId}')")"; then
      ralph_log_error 'Task %sの相談再開に失敗しました（Claim取得/版照合）。次の候補を確認します。\n' "$task_id"
      continue
    fi
    RALPH_EXECUTION_ROOT="$(jq -r '.worktreePath' <<<"$actual")"
    RALPH_RUN_TASK_ID="$task_id"
    printf '\n相談からの再開Context（Claim取得済み。Taskを選択・Claimし直さない）:\n' >>"$rendered_prompt"
    jq '.result.structuredContent' <<<"$response" >>"$rendered_prompt"
    printf '\n保存済みContextを読み、全相談の現在の結論・現在のTask要件・PR/SHAと照合して再判断する。旧blocked結果を再送しない。保存済み検証を変更後のSHAに流用しない。\n' >>"$rendered_prompt"
    return 0
  done < <(jq -c '.resumptions[]? | select(.state == "ready")' <<<"$summary")
  # 全再開候補が失敗しても、通常候補があればAgentの選択へ進む。
  (( $(jq '.availableCount - .readyCount' <<<"$summary") > 0 ))
}

# Agentの実行観測（`record_agent_run`）。起動するRoleのAgent Credentialと`X-Compass-Active-Role`で、このProjectの自分の実行だけを報告する。
# 観測の報告はAgentの稼働の証明ではない。報告に失敗してもAgentの実行は止めない（Operational Logへ残す）。
RALPH_RUN_ID=""
RALPH_RUN_TASK_ID=""
RALPH_RUN_HEARTBEAT_PID=""

backend_record_run() {
  local event="$1"
  local result="${2:-}"
  local reason="${3:-}"
  local arguments
  [[ -n "$RALPH_RUN_ID" ]] || return 0
  arguments="$(jq -cn \
    --arg run_id "$RALPH_RUN_ID" \
    --arg project_id "$COMPASS_PROJECT_ID" \
    --arg event "$event" \
    --arg provider "$AGENT_PROVIDER" \
    --arg task_id "$RALPH_RUN_TASK_ID" \
    --argjson stale "$RALPH_RUN_STALE_AFTER_SECONDS" \
    --arg result "$result" \
    --arg reason "$reason" \
    '{runId: $run_id, scope: {kind: "project", id: $project_id}, event: $event, source: "ralph"}
      + (if $event == "started" then {provider: $provider} + (if $task_id != "" then {workRef: {kind: "task", id: $task_id}} else {} end) else {} end)
      + (if $event == "finished" then {result: $result} + (if $reason != "" then {reason: $reason} else {} end) else {staleAfterSeconds: $stale} end)')"
  # 関数呼出しにredirectを付けない（実行中にSIGTERMを受けると、退避されたloggingのfdが残りcleanupが終わらない）。
  local response
  response="$(mcp_call 'record_agent_run' "$arguments")" || {
    ralph_log_error '実行観測（%s）を記録できませんでした。Agentの実行は続けます。run=%s\n' "$event" "$RALPH_RUN_ID"
    return 0
  }
  : "$response"
}

backend_run_started() {
  RALPH_RUN_ID="ralph-$(date +%s)-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  backend_record_run started
  # 実行中は間隔ごとに観測を報告する。Ralphが停止して報告が途絶えると、Serverは観測途絶として扱う。
  # 観測の報告はloopの子プロセスで行う。worktree lock・loggingのpipe等の継承fdを閉じ、Runnerの停止・強制終了後に
  # lockや出力を保持しない。loopが無くなれば報告をやめ、Serverは観測途絶として扱う。
  local loop_pid=$$
  (
    exec </dev/null >>"$RALPH_LOG_FILE" 2>&1
    for fd_path in /dev/fd/*; do
      fd="${fd_path##*/}"
      if [[ "$fd" =~ ^[0-9]+$ ]] && (( fd > 2 )); then eval "exec ${fd}>&-" 2>/dev/null || true; fi
    done
    RALPH_LOGGING_ACTIVE=false
    heartbeat_sleep_pid=""
    trap 'kill "$heartbeat_sleep_pid" 2>/dev/null; exit 0' TERM
    while kill -0 "$loop_pid" 2>/dev/null; do
      sleep "$RALPH_RUN_HEARTBEAT_SECONDS" &
      heartbeat_sleep_pid=$!
      wait "$heartbeat_sleep_pid"
      kill -0 "$loop_pid" 2>/dev/null || exit 0
      backend_record_run observed
    done
  ) &
  RALPH_RUN_HEARTBEAT_PID=$!
}

backend_stop_run_heartbeat() {
  if [[ -n "$RALPH_RUN_HEARTBEAT_PID" ]]; then
    kill "$RALPH_RUN_HEARTBEAT_PID" 2>/dev/null || true
    wait "$RALPH_RUN_HEARTBEAT_PID" || true
    RALPH_RUN_HEARTBEAT_PID=""
  fi
}

backend_run_finished() {
  local exit_status="$1"
  local reason="${2:-}"
  backend_stop_run_heartbeat
  if (( exit_status == 0 )); then
    backend_record_run finished succeeded
  else
    backend_record_run finished failed "${reason:-終了コード ${exit_status}}"
  fi
  RALPH_RUN_ID=""
  RALPH_RUN_TASK_ID=""
}

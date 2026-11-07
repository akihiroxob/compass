import type { IntentActor } from "../../domain/IntentRepository.ts";

/**
 * 現在の操作の主体。認可済みの入口（Web UIのHuman操作・MCPのAgent操作）が固定した主体を返し、Directionは認可の判断に使わず来歴として記録する。
 * 主体を特定できない保守呼出しは`system`を返す。serverが配線する。
 */
export interface DirectionActorPort {
  current(): IntentActor;
}

import type { Generated } from "kysely";
import type { AccessDatabase } from "@compass/access";
import type { DirectionDatabase } from "@compass/direction";
import type { WorkDatabase } from "@compass/work";

/** 単一SQLite fileの全table。各Contextが所有するtable定義をserverが合成する。 */
export type Database = DirectionDatabase & WorkDatabase & AccessDatabase;

export type DatabaseMetadata = Generated<number>;

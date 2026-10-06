import { sql, type Kysely } from "kysely";
import type { Database } from "../../src/bootstrap/database/schema.ts";

/**
 * Workspace導入前のserverが作った`project`とその子table（Directionが所有していた時点のschema）。
 * 戦略値（Mission等）はProjectの列・子tableが正本で、`workspace_id`・`strategy_migrated_at`は無い。
 */
export const createLegacyProjectTables = async (database: Kysely<Database>): Promise<void> => {
  await sql`create table project (
    id text primary key, name text not null, description text, mission text not null, vision text,
    created_at integer not null, updated_at integer not null,
    status text not null default 'active' check (status in ('active', 'archived')), archived_at integer, archive_reason text
  )`.execute(database);
  for (const table of ["project_principle", "project_constraint"]) {
    await sql`create table ${sql.table(table)} (
      id text primary key, project_id text not null references project(id) on delete cascade,
      value text not null, sort_order integer not null
    )`.execute(database);
  }
  await sql`create table project_repository_link (
    id text primary key, project_id text not null references project(id) on delete cascade,
    name text not null, url text not null, sort_order integer not null
  )`.execute(database);
  await sql`create table project_resource (
    id text primary key, project_id text not null references project(id) on delete cascade,
    name text not null, url text not null, kind text, sort_order integer not null
  )`.execute(database);
};

export type LegacyProjectInput = {
  name: string;
  description?: string | null;
  mission: string;
  vision?: string | null;
  principles?: string[];
  constraints?: string[];
  repositories?: { name: string; url: string }[];
  createdAt: number;
};

/** 旧serverのProject作成と同じ行を書く（Workspaceへの所属なし）。 */
export const insertLegacyProject = async (database: Kysely<Database>, input: LegacyProjectInput) => {
  const id = crypto.randomUUID();
  await sql`insert into project (id, name, description, mission, vision, created_at, updated_at)
    values (${id}, ${input.name}, ${input.description ?? null}, ${input.mission}, ${input.vision ?? null},
      ${input.createdAt}, ${input.createdAt})`.execute(database);
  for (const [table, values] of [
    ["project_principle", input.principles ?? []],
    ["project_constraint", input.constraints ?? []],
  ] as const) {
    for (const [sortOrder, value] of values.entries()) {
      await sql`insert into ${sql.table(table)} (id, project_id, value, sort_order)
        values (${crypto.randomUUID()}, ${id}, ${value}, ${sortOrder})`.execute(database);
    }
  }
  for (const [sortOrder, { name, url }] of (input.repositories ?? []).entries()) {
    await sql`insert into project_repository_link (id, project_id, name, url, sort_order)
      values (${crypto.randomUUID()}, ${id}, ${name}, ${url}, ${sortOrder})`.execute(database);
  }
  return { id, createdAt: input.createdAt, updatedAt: input.createdAt };
};

/** 旧serverのProject archiveと同じ列を書く。 */
export const archiveLegacyProject = async (database: Kysely<Database>, projectId: string, reason: string, at: number) => {
  await sql`update project set status = 'archived', archived_at = ${at}, archive_reason = ${reason}, updated_at = ${at}
    where id = ${projectId}`.execute(database);
};

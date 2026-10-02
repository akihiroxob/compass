import { z } from "zod";
import {
  credentialDefaultRotationGraceHours,
  credentialDefaultTtlDays,
  credentialKinds,
  credentialMaxRotationGraceHours,
  credentialMaxTtlDays,
  credentialMinTtlDays,
  runtimeScopes,
} from "../domain/model/AccessCredential.ts";
import { principalIdSchema } from "./projectGrantSchema.ts";
import { parseWith } from "./projectSchema.ts";

const expiresInDaysSchema = z
  .number()
  .int("expiresInDays must be an integer")
  .min(credentialMinTtlDays, `expiresInDays must be ${credentialMinTtlDays} or more`)
  .max(credentialMaxTtlDays, `expiresInDays must be ${credentialMaxTtlDays} or fewer`)
  .default(credentialDefaultTtlDays);

const scopesSchema = z
  .array(z.enum(runtimeScopes, { error: `scopes must be some of: ${runtimeScopes.join(", ")}` }))
  .transform((scopes) => [...new Set(scopes)].sort());

/** Agent Credentialはscopeを持たない（認可はRole Grant）。Runtime Credentialは1つ以上のscopeが必須。 */
export const issueCredentialSchema = z
  .object({
    kind: z.enum(credentialKinds, { error: `kind must be one of: ${credentialKinds.join(", ")}` }),
    principalId: principalIdSchema,
    scopes: scopesSchema.optional(),
    expiresInDays: expiresInDaysSchema,
  })
  .superRefine((value, context) => {
    if (value.kind === "agent" && value.scopes !== undefined && value.scopes.length > 0) {
      context.addIssue({ code: "custom", path: ["scopes"], message: "scopes are not allowed for agent credentials" });
    }
    if (value.kind === "runtime" && (value.scopes === undefined || value.scopes.length === 0)) {
      context.addIssue({ code: "custom", path: ["scopes"], message: "runtime credentials require at least one scope" });
    }
  })
  .transform((value) => ({ ...value, scopes: value.kind === "runtime" ? (value.scopes ?? []) : [] }));

export const rotateCredentialSchema = z.object({
  expiresInDays: expiresInDaysSchema,
  graceHours: z
    .number()
    .int("graceHours must be an integer")
    .min(0, "graceHours must be 0 or more")
    .max(credentialMaxRotationGraceHours, `graceHours must be ${credentialMaxRotationGraceHours} or fewer`)
    .default(credentialDefaultRotationGraceHours),
});

export type IssueCredentialInput = z.infer<typeof issueCredentialSchema>;
export type RotateCredentialInput = z.infer<typeof rotateCredentialSchema>;

export const parseIssueCredentialInput = (input: unknown): IssueCredentialInput =>
  parseWith(issueCredentialSchema, input, "Credential");

export const parseRotateCredentialInput = (input: unknown): RotateCredentialInput =>
  parseWith(rotateCredentialSchema, input ?? {}, "Credential");

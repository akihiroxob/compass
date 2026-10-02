import { z } from "zod";
import {
  humanRoles,
  invitationDefaultTtlHours,
  invitationMaxTtlHours,
  invitationMinTtlHours,
  normalizeEmail,
} from "../domain/model/HumanAuth.ts";
import { parseWith } from "./projectSchema.ts";

export const humanRoleSchema = z.enum(humanRoles, { error: `role must be one of: ${humanRoles.join(", ")}` });

export const createInvitationSchema = z.object({
  email: z
    .string()
    .transform(normalizeEmail)
    .pipe(z.email("email must be a valid email address").max(320, "email must be 320 characters or fewer")),
  role: humanRoleSchema,
  expiresInHours: z
    .number()
    .int("expiresInHours must be an integer")
    .min(invitationMinTtlHours, `expiresInHours must be ${invitationMinTtlHours} or more`)
    .max(invitationMaxTtlHours, `expiresInHours must be ${invitationMaxTtlHours} or fewer`)
    .default(invitationDefaultTtlHours),
});

export const changeMemberRoleSchema = z.object({ role: humanRoleSchema });

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export const parseCreateInvitationInput = (input: unknown): CreateInvitationInput =>
  parseWith(createInvitationSchema, input, "Invitation");

export const parseChangeMemberRoleInput = (input: unknown) => parseWith(changeMemberRoleSchema, input, "Membership");

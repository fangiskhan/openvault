import { z } from "zod";

// Enumerated values live here as plain string unions (no Prisma enums, so the
// schema stays SQLite + Postgres compatible). zod enforces them at the edge.
export const ITEM_TYPES = ["note", "meeting", "task", "message", "file", "spreadsheet"] as const;
export const SOURCES = ["local", "upload", "slack", "jira", "github"] as const;
export const RELATION_KINDS = ["related", "depends", "parent", "shares"] as const;
export const SEARCH_SCOPES = ["project", "connected", "all"] as const;

export type ItemType = (typeof ITEM_TYPES)[number];
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "color must be a hex like #8b7cf6")
    .optional(),
});

export const updateProjectSchema = createProjectSchema.partial();

export const createItemSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(300),
  body: z.string().max(1_000_000).optional(),
  type: z.enum(ITEM_TYPES).optional(),
});

export const updateItemSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().max(1_000_000).optional(),
  type: z.enum(ITEM_TYPES).optional(),
});

export const connectSchema = z.object({
  toProjectId: z.string().min(1),
  kind: z.enum(RELATION_KINDS).optional(),
});

export const searchScopeSchema = z.enum(SEARCH_SCOPES).catch("project");

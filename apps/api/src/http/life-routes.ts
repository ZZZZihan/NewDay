import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { localDateSchema } from "@newday/core/domain/planner-model";
import type { LifeService } from "../services/life-service.js";

const id = z.string().min(1).max(512);
const params = z.strictObject({ id });
const linkParams = z.strictObject({ id, taskId: id });
const title = z.string().trim().min(1).max(200);
const folderId = id.nullable();
const folderName = z.string().trim().min(1).max(80);
const kind = z.enum(["note", "link"]);
const resourceInput = z.strictObject({ folderId, kind, title, content: z.string().max(10_000), source: z.string().max(1_000) });

export function registerLifeRoutes(app: FastifyInstance, life: LifeService) {
  app.get("/api/life/workspace", () => life.workspace());
  app.post("/api/life/inbox", (request) => life.capture(z.strictObject({
    title, notes: z.string().max(10_000), sourceResourceId: id.nullable().optional(),
  }).parse(request.body)));
  app.post("/api/life/inbox/:id/discard", (request) => life.removeInbox(params.parse(request.params).id));
  app.post("/api/life/inbox/:id/task", (request) => life.toTask(params.parse(request.params).id,
    z.strictObject({ startDate: localDateSchema, endDate: localDateSchema }).parse(request.body)));
  app.post("/api/life/inbox/:id/resource", (request) => life.toResource(params.parse(request.params).id,
    z.strictObject({ folderId, kind, source: z.string().max(1_000) }).parse(request.body)));
  app.post("/api/life/folders", (request) => life.createFolder(z.strictObject({ parentId: folderId, name: folderName }).parse(request.body)));
  app.post("/api/life/folders/:id/rename", (request) => life.renameFolder(params.parse(request.params).id,
    z.strictObject({ name: folderName }).parse(request.body).name));
  app.post("/api/life/resources", (request) => life.createResource(resourceInput.parse(request.body)));
  app.post("/api/life/resources/:id/update", (request) => life.updateResource(params.parse(request.params).id,
    resourceInput.parse(request.body)));
  app.post("/api/life/resources/:id/links", (request) => life.link(params.parse(request.params).id,
    z.strictObject({ taskId: id }).parse(request.body).taskId));
  app.post("/api/life/resources/:id/links/:taskId/remove", (request) => {
    const { id: resourceId, taskId } = linkParams.parse(request.params);
    return life.unlink(resourceId, taskId);
  });
}

import type { ModelUsage } from "@newday/core/contracts/agent-planning";
import type { CaptureModelInput } from "@newday/core/contracts/task-capture";
import { OpenAICompatiblePlanningModel, type OpenAICompatibleModelOptions } from "./openai-compatible-model.js";
import { captureMessages, captureProviderJsonSchema } from "./task-capture-prompt.js";

export type CaptureModelGeneration = { output: unknown; modelId: string; usage: ModelUsage };

/** The model receives text only. Task creation belongs to the capture service. */
export interface TaskCaptureModel {
  readonly modelId: string;
  generate(input: CaptureModelInput, signal: AbortSignal): Promise<CaptureModelGeneration>;
}

export class OpenAICompatibleTaskCaptureModel implements TaskCaptureModel {
  readonly modelId: string;
  private readonly transport: OpenAICompatiblePlanningModel;

  constructor(private readonly options: OpenAICompatibleModelOptions) {
    this.transport = new OpenAICompatiblePlanningModel(options);
    this.modelId = this.transport.modelId;
  }

  generate(input: CaptureModelInput, signal: AbortSignal): Promise<CaptureModelGeneration> {
    return this.transport.generateStructured(
      captureMessages(input, { includeOutputSchema: this.options.requestProfile === "deepseek-json" }),
      captureProviderJsonSchema, "newday_task_capture_v1", signal,
    );
  }
}

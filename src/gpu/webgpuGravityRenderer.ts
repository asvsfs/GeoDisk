import type { FieldViewMode, MassBody, UniformGridConfig } from '../physics/types';
import { GRAVITY_COMPUTE_WGSL, SPACETIME_RENDER_WGSL } from './shaders';

// Minimal standalone WebGPU type declarations so TypeScript builds cleanly without @webgpu/types
interface GPUAdapterLike {
  requestDevice(): Promise<GPUDeviceLike | null>;
}
interface GPUCanvasContextLike {
  configure(config: { device: GPUDeviceLike; format: string; alphaMode?: string }): void;
  getCurrentTexture(): { createView(): unknown };
}
interface GPUDeviceLike {
  queue: {
    writeBuffer(buffer: GPUBufferLike, bufferOffset: number, data: BufferSource): void;
    submit(commands: unknown[]): void;
  };
  createBuffer(desc: { size: number; usage: number }): GPUBufferLike;
  createShaderModule(desc: { code: string }): unknown;
  createComputePipeline(desc: unknown): GPUComputePipelineLike;
  createRenderPipeline(desc: unknown): GPURenderPipelineLike;
  createBindGroup(desc: unknown): unknown;
  createCommandEncoder(): GPUCommandEncoderLike;
  destroy(): void;
}
interface GPUBufferLike {
  destroy(): void;
}
interface GPUComputePipelineLike {
  getBindGroupLayout(index: number): unknown;
}
interface GPURenderPipelineLike {
  getBindGroupLayout(index: number): unknown;
}
interface GPUCommandEncoderLike {
  beginComputePass(): {
    setPipeline(p: GPUComputePipelineLike): void;
    setBindGroup(index: number, bg: unknown): void;
    dispatchWorkgroups(x: number, y?: number, z?: number): void;
    end(): void;
  };
  beginRenderPass(desc: unknown): {
    setPipeline(p: GPURenderPipelineLike): void;
    setBindGroup(index: number, bg: unknown): void;
    draw(vertexCount: number): void;
    end(): void;
  };
  finish(): unknown;
}

const GPU_BUFFER_USAGE = {
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
};

const MAX_MASSES_GPU = 256;

export class WebGPUGameBackend {
  private readonly device: GPUDeviceLike;
  private readonly context: GPUCanvasContextLike;
  private readonly config: UniformGridConfig;

  private readonly uniformBuffer: GPUBufferLike;
  private readonly massBuffer: GPUBufferLike;
  private readonly gridBuffer: GPUBufferLike;

  private readonly computePipeline: GPUComputePipelineLike;
  private readonly renderPipeline: GPURenderPipelineLike;
  private readonly computeBindGroup: unknown;
  private readonly renderBindGroup: unknown;

  private readonly uniformArray = new ArrayBuffer(48);
  private readonly uniformU32 = new Uint32Array(this.uniformArray);
  private readonly uniformF32 = new Float32Array(this.uniformArray);
  private readonly massStaging = new Float32Array(MAX_MASSES_GPU * 8);

  private constructor(
    device: GPUDeviceLike,
    context: GPUCanvasContextLike,
    format: string,
    config: UniformGridConfig
  ) {
    this.device = device;
    this.context = context;
    this.config = config;

    this.uniformBuffer = device.createBuffer({
      size: 48,
      usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
    });

    this.massBuffer = device.createBuffer({
      size: MAX_MASSES_GPU * 32,
      usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST,
    });

    const cellCount = config.cols * config.rows;
    this.gridBuffer = device.createBuffer({
      size: cellCount * 16,
      usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST,
    });

    const computeModule = device.createShaderModule({ code: GRAVITY_COMPUTE_WGSL });
    this.computePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: computeModule, entryPoint: 'main' },
    });

    const renderModule = device.createShaderModule({ code: SPACETIME_RENDER_WGSL });
    this.renderPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: renderModule, entryPoint: 'vs_main' },
      fragment: {
        module: renderModule,
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.computeBindGroup = device.createBindGroup({
      layout: this.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.massBuffer } },
        { binding: 2, resource: { buffer: this.gridBuffer } },
      ],
    });

    this.renderBindGroup = device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.gridBuffer } },
      ],
    });
  }

  public static async create(
    canvas: HTMLCanvasElement,
    config: UniformGridConfig
  ): Promise<WebGPUGameBackend | null> {
    const nav = navigator as unknown as {
      gpu?: {
        requestAdapter(): Promise<GPUAdapterLike | null>;
        getPreferredCanvasFormat(): string;
      };
    };

    if (!nav.gpu) return null;

    try {
      const adapter = await nav.gpu.requestAdapter();
      if (!adapter) return null;

      const device = await adapter.requestDevice();
      if (!device) return null;

      const ctx = canvas.getContext('webgpu') as unknown as GPUCanvasContextLike | null;
      if (!ctx) {
        device.destroy();
        return null;
      }

      const format = nav.gpu.getPreferredCanvasFormat();
      ctx.configure({ device, format, alphaMode: 'opaque' });
      return new WebGPUGameBackend(device, ctx, format, config);
    } catch {
      return null;
    }
  }

  public renderFrame(
    masses: readonly MassBody[],
    speedOfLight: number,
    viewMode: FieldViewMode,
    elapsedTime: number,
    recomputeGrid: boolean
  ): void {
    const massCount = Math.min(masses.length, MAX_MASSES_GPU);
    const modeIdx = viewMode === 'spacetime' ? 0 : viewMode === 'contours' ? 1 : 2;

    this.uniformU32[0] = this.config.cols;
    this.uniformU32[1] = this.config.rows;
    this.uniformU32[2] = massCount;
    this.uniformU32[3] = modeIdx;
    this.uniformF32[4] = this.config.worldWidth;
    this.uniformF32[5] = this.config.worldHeight;
    this.uniformF32[6] = this.config.potentialRefRadius;
    this.uniformF32[7] = speedOfLight;
    this.uniformF32[8] = elapsedTime;

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformArray);

    if (recomputeGrid) {
      for (let i = 0; i < massCount; i++) {
        const m = masses[i];
        const base = i * 8;
        this.massStaging[base] = m.x;
        this.massStaging[base + 1] = m.y;
        this.massStaging[base + 2] = m.mu;
        this.massStaging[base + 3] = m.softening;
        this.massStaging[base + 4] = m.spin;
        this.massStaging[base + 5] = m.radius;
        this.massStaging[base + 6] = m.kind === 'singularity' ? 2 : m.kind === 'compact' ? 1 : 0;
        this.massStaging[base + 7] = 0;
      }
      if (massCount > 0) {
        this.device.queue.writeBuffer(
          this.massBuffer,
          0,
          this.massStaging.subarray(0, massCount * 8)
        );
      }
    }

    const encoder = this.device.createCommandEncoder();

    if (recomputeGrid) {
      const computePass = encoder.beginComputePass();
      computePass.setPipeline(this.computePipeline);
      computePass.setBindGroup(0, this.computeBindGroup);
      computePass.dispatchWorkgroups(
        Math.ceil(this.config.cols / 8),
        Math.ceil(this.config.rows / 8),
        1
      );
      computePass.end();
    }

    const textureView = this.context.getCurrentTexture().createView();
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0.027, g: 0.039, b: 0.063, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, this.renderBindGroup);
    renderPass.draw(3);
    renderPass.end();

    this.device.queue.submit([encoder.finish()]);
  }

  public dispose(): void {
    this.uniformBuffer.destroy();
    this.massBuffer.destroy();
    this.gridBuffer.destroy();
    this.device.destroy();
  }
}

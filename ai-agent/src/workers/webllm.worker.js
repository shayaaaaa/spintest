// Runs WebLLM (MLC, WebGPU) off the main thread, reading model files straight from the Hub.
import { WebWorkerMLCEngineHandler } from '../../vendor/web-llm.mjs';
import { HubArtifactCache } from '../models/local/hub-cache.js';

globalThis.__aiAgentArtifactCache = new HubArtifactCache();
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);

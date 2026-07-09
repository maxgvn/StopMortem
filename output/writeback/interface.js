/**
 * WritebackAdapter contract:
 *   publish(postmortem, portrait) -> Promise<{ location: string }>
 *
 * Implementations decide where the finished post-mortem lands. v1 ships
 * local-file-adapter.js only; hubspot-adapter.stub.js documents the future
 * real integration without implementing it.
 */
export const WRITEBACK_ADAPTER_CONTRACT = "publish(postmortem, portrait) -> Promise<{ location: string }>";

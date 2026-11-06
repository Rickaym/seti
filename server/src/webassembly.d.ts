/** The part of the WebAssembly global the poller engine uses; the server's lib leaves it out. */
declare namespace WebAssembly {
  interface MemoryDescriptor {
    initial: number
    maximum?: number
  }
  interface Memory {
    readonly buffer: ArrayBuffer
    grow: (delta: number) => number
  }
  const Memory: new (descriptor: MemoryDescriptor) => Memory
}

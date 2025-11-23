export class PeerBuffer {
  constructor(numChunks, chunkSize) {
    this.numChunks = numChunks | 0;
    this.chunkSize = chunkSize | 0;
    this.totalSize = this.numChunks * this.chunkSize;
    this.buffer = new Uint8Array(this.totalSize);
    this.have = new Array(this.numChunks).fill(false);
    this.haveCount = 0;
    this.contiguousChunkEnd = 0; // exclusive
    this.contiguousByteEnd = 0; // exclusive
  }

  setChunk(index, payload) {
    if (index < 0 || index >= this.numChunks) return false;
    if (!(payload instanceof Uint8Array)) return false;
    if (payload.length !== this.chunkSize) return false;
    const start = index * this.chunkSize;
    this.buffer.set(payload, start);
    if (!this.have[index]) {
      this.have[index] = true;
      this.haveCount++;
      while (
        this.contiguousChunkEnd < this.numChunks &&
        this.have[this.contiguousChunkEnd]
      ) {
        this.contiguousChunkEnd++;
      }
      this.contiguousByteEnd = Math.min(
        this.contiguousChunkEnd * this.chunkSize,
        this.totalSize
      );
    }
    return true;
  }

  readRange(start, length) {
    if (start < 0 || length <= 0) return new Uint8Array(0);
    const maxEnd = Math.min(this.totalSize, this.contiguousByteEnd);
    let end = start + length;
    if (end > maxEnd) end = maxEnd;
    if (start >= end) return new Uint8Array(0);
    return this.buffer.slice(start, end);
  }

  getLargestContiguousEnd() {
    return this.contiguousByteEnd;
  }
}

import XCTest

@testable import AmbientAi

final class SileroChunkBufferTests: XCTestCase {

    func testEmptyAppendReturnsNoChunks() {
        var buffer = SileroChunkBuffer(chunkSize: 4096)
        let chunks = buffer.append([])
        XCTAssertEqual(chunks.count, 0)
        XCTAssertEqual(buffer.pendingSampleCount, 0)
    }

    func testPartialAppendStaysBuffered() {
        var buffer = SileroChunkBuffer(chunkSize: 4096)
        let chunks = buffer.append(Array(repeating: Float(0.5), count: 1_000))
        XCTAssertEqual(chunks.count, 0)
        XCTAssertEqual(buffer.pendingSampleCount, 1_000)
    }

    func testEmitsExactlyOneChunkAtBoundary() {
        var buffer = SileroChunkBuffer(chunkSize: 4096)
        let chunks = buffer.append(Array(repeating: Float(0.5), count: 4_096))
        XCTAssertEqual(chunks.count, 1)
        XCTAssertEqual(chunks[0].count, 4_096)
        XCTAssertEqual(buffer.pendingSampleCount, 0)
    }

    func testEmitsMultipleChunksAndKeepsRemainder() {
        var buffer = SileroChunkBuffer(chunkSize: 4096)
        // 4096 * 3 + 17 = three full chunks with a 17-sample tail.
        let chunks = buffer.append(Array(repeating: Float(0.3), count: 4_096 * 3 + 17))
        XCTAssertEqual(chunks.count, 3)
        XCTAssertEqual(buffer.pendingSampleCount, 17)
    }

    func testChunkBoundariesPreserveOriginalOrder() {
        // Generate a recognisable ramp so we can verify the slicing splits
        // along the right sample indices.
        var buffer = SileroChunkBuffer(chunkSize: 4)
        // Three chunks (12 samples) plus 1 leftover.
        let input: [Float] = (0..<13).map { Float($0) }
        let chunks = buffer.append(input)
        XCTAssertEqual(chunks, [
            [0, 1, 2, 3],
            [4, 5, 6, 7],
            [8, 9, 10, 11],
        ])
        XCTAssertEqual(buffer.pendingSampleCount, 1)
    }

    func testAccumulatesAcrossSmallAppends() {
        var buffer = SileroChunkBuffer(chunkSize: 4)
        XCTAssertEqual(buffer.append([1, 2]).count, 0)
        XCTAssertEqual(buffer.append([3]).count, 0)
        let chunks = buffer.append([4, 5])
        XCTAssertEqual(chunks, [[1, 2, 3, 4]])
        XCTAssertEqual(buffer.pendingSampleCount, 1)
    }

    func testResetDropsPartialBuffer() {
        var buffer = SileroChunkBuffer(chunkSize: 4096)
        _ = buffer.append(Array(repeating: Float(0.1), count: 2_000))
        XCTAssertEqual(buffer.pendingSampleCount, 2_000)
        buffer.reset()
        XCTAssertEqual(buffer.pendingSampleCount, 0)
        // After reset the next chunk should land cleanly.
        let chunks = buffer.append(Array(repeating: Float(0.1), count: 4_096))
        XCTAssertEqual(chunks.count, 1)
    }
}

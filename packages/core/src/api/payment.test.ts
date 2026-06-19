import { afterEach, describe, expect, it, vi } from "vitest";

import { configureTransport } from "../transport/config";
import { listPaymentHistory } from "./payment";

function jsonResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn();

function configure() {
  configureTransport({
    baseUrl: "https://backend.test",
    getAuthHeaders: async () => ({ Authorization: "Bearer tok-1" }),
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
}

afterEach(() => {
  fetchMock.mockReset();
});

describe("payment API", () => {
  it("loads unified payment history including topups", async () => {
    configure();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        items: [
          {
            id: "grant_1",
            kind: "topup",
            status: "paid",
            amountPaidCents: 7500,
            currency: "usd",
            description: "PIN AI credits",
            createdAt: 1781723534,
            hostedInvoiceUrl: null,
            pdfUrl: null,
          },
        ],
      }),
    );

    const items = await listPaymentHistory(12);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://backend.test/api/payment/history?limit=12",
      expect.anything(),
    );
    expect(items).toEqual([
      {
        id: "grant_1",
        kind: "topup",
        status: "paid",
        amountPaidCents: 7500,
        currency: "usd",
        description: "PIN AI credits",
        createdAt: 1781723534,
        hostedInvoiceUrl: null,
        pdfUrl: null,
      },
    ]);
  });
});

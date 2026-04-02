import { createHash } from "node:crypto";

import type { PersonalToolExecutor } from "./executor.js";
import type {
  PersonalConnectedSourceRecord,
  UpsertPersonalContextItemInput,
} from "./repository.js";

interface PersonalSourceAuthMetadata {
  userId: string | null;
  authConfigId: string | null;
}

export interface PersonalSyncSpecContext {
  source: PersonalConnectedSourceRecord;
  executor: PersonalToolExecutor;
  syncedAt: string;
}

export interface PersonalSyncSpec {
  toolkit: string;
  sync(context: PersonalSyncSpecContext): Promise<UpsertPersonalContextItemInput[]>;
}

interface PersonalNormalizedItem {
  id: string;
  sourceId: string;
  userId: string;
  toolkit: string;
  itemType: string;
  externalId: string;
  externalParentId: string | null;
  title: string | null;
  contentText: string | null;
  url: string | null;
  occurredAt: string | null;
  attributes: Record<string, unknown>;
  raw: Record<string, unknown>;
  searchText: string;
}

const parseJsonObject = (
  raw: string | null | undefined,
): Record<string, unknown> => {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asRecordArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(asRecord) : [];

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const buildContentHash = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

const buildSearchText = (
  parts: Array<string | null | undefined>,
): string =>
  parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join("\n");

const extractSourceAuthMetadata = (
  source: PersonalConnectedSourceRecord,
): PersonalSourceAuthMetadata => {
  const metadata = parseJsonObject(source.authMetadataJson);
  return {
    userId: stringOrNull(metadata.userId),
    authConfigId: stringOrNull(metadata.authConfigId),
  };
};

const normalizeGmailMessage = (
  source: PersonalConnectedSourceRecord,
  payload: unknown,
): PersonalNormalizedItem | null => {
  const row = asRecord(payload);
  const preview = asRecord(row.preview);
  const messageId = stringOrNull(row.messageId) ?? stringOrNull(row.id);

  if (!messageId) {
    return null;
  }

  const threadId = stringOrNull(row.threadId);
  const subject = stringOrNull(row.subject);
  const contentText =
    stringOrNull(preview.body) ??
    stringOrNull(row.snippet) ??
    stringOrNull(row.body);
  const sender = stringOrNull(row.sender);
  const to = stringOrNull(row.to);
  const occurredAt =
    stringOrNull(row.messageTimestamp) ??
    stringOrNull(row.internalDate) ??
    stringOrNull(row.createdAt);
  const url =
    stringOrNull(row.url) ??
    (messageId ? `https://mail.google.com/mail/u/0/#inbox/${messageId}` : null);

  return {
    id: `${source.id}:email:${messageId}`,
    sourceId: source.id,
    userId: source.userId,
    toolkit: source.toolkit,
    itemType: "email",
    externalId: messageId,
    externalParentId: threadId,
    title: subject,
    contentText,
    url,
    occurredAt,
    attributes: {
      sender,
      to,
      threadId,
    },
    raw: row,
    searchText: buildSearchText([subject, contentText, sender, to]),
  };
};

const normalizeGoogleCalendarEvent = (
  source: PersonalConnectedSourceRecord,
  calendar: Record<string, unknown>,
  payload: unknown,
): PersonalNormalizedItem | null => {
  const row = asRecord(payload);
  const start = asRecord(row.start);
  const end = asRecord(row.end);
  const organizer = asRecord(row.organizer);
  const attendees = asRecordArray(row.attendees);
  const eventId = stringOrNull(row.id);
  const calendarId = stringOrNull(calendar.id) ?? "primary";

  if (!eventId) {
    return null;
  }

  const summary = stringOrNull(row.summary);
  const description = stringOrNull(row.description);
  const organizerEmail = stringOrNull(organizer.email);
  const attendeeEmails = attendees
    .map((attendee) => stringOrNull(attendee.email))
    .filter((email): email is string => email !== null);
  const occurredAt =
    stringOrNull(start.dateTime) ??
    stringOrNull(start.date) ??
    stringOrNull(row.created) ??
    stringOrNull(row.updated);
  const endAt =
    stringOrNull(end.dateTime) ??
    stringOrNull(end.date);

  return {
    id: `${source.id}:calendar_event:${calendarId}:${eventId}`,
    sourceId: source.id,
    userId: source.userId,
    toolkit: source.toolkit,
    itemType: "calendar_event",
    externalId: `${calendarId}:${eventId}`,
    externalParentId: stringOrNull(row.recurringEventId),
    title: summary,
    contentText: description,
    url: stringOrNull(row.htmlLink),
    occurredAt,
    attributes: {
      calendarId,
      calendarSummary: stringOrNull(calendar.summary),
      organizerEmail,
      attendeesCount: attendeeEmails.length,
      attendeeEmails,
      status: stringOrNull(row.status),
      start: occurredAt,
      end: endAt,
    },
    raw: {
      calendar,
      event: row,
    },
    searchText: buildSearchText([
      summary,
      description,
      stringOrNull(calendar.summary),
      organizerEmail,
      attendeeEmails.join(" "),
    ]),
  };
};

const gmailSyncSpec: PersonalSyncSpec = {
  toolkit: "gmail",
  async sync({ source, executor, syncedAt }) {
    const metadata = extractSourceAuthMetadata(source);
    if (!metadata.userId) {
      return [];
    }

    const summaryResult = await executor.execute("GMAIL_FETCH_EMAILS", {
      connectedAccountId: source.connectedAccountId,
      userId: metadata.userId,
      arguments: {
        user_id: "me",
        ids_only: true,
        max_results: 10,
      },
    });

    const summaryData = asRecord(summaryResult.data);
    const messages = Array.isArray(summaryData.messages)
      ? summaryData.messages
      : [];
    const rows: UpsertPersonalContextItemInput[] = [];

    for (const message of messages) {
      const messageRow = asRecord(message);
      const messageId =
        stringOrNull(messageRow.messageId) ?? stringOrNull(messageRow.id);
      if (!messageId) {
        continue;
      }

      const detailResult = await executor.execute(
        "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
        {
          connectedAccountId: source.connectedAccountId,
          userId: metadata.userId,
          arguments: {
            user_id: "me",
            message_id: messageId,
            format: "metadata",
          },
        },
      );
      const normalized = normalizeGmailMessage(source, detailResult.data);
      if (!normalized) {
        continue;
      }

      rows.push({
        id: normalized.id,
        sourceId: normalized.sourceId,
        userId: normalized.userId,
        toolkit: normalized.toolkit,
        itemType: normalized.itemType,
        externalId: normalized.externalId,
        externalParentId: normalized.externalParentId,
        title: normalized.title,
        contentText: normalized.contentText,
        url: normalized.url,
        occurredAt: normalized.occurredAt,
        syncedAt,
        contentHash: buildContentHash(
          JSON.stringify({
            title: normalized.title,
            contentText: normalized.contentText,
            attributes: normalized.attributes,
          }),
        ),
        attributesJson: JSON.stringify(normalized.attributes),
        rawJson: JSON.stringify(normalized.raw),
        searchText: normalized.searchText,
        isDeleted: false,
      });
    }

    return rows;
  },
};

const googleCalendarSyncSpec: PersonalSyncSpec = {
  toolkit: "googlecalendar",
  async sync({ source, executor, syncedAt }) {
    const metadata = extractSourceAuthMetadata(source);
    if (!metadata.userId) {
      return [];
    }

    const calendarsResult = await executor.execute("GOOGLECALENDAR_LIST_CALENDARS", {
      connectedAccountId: source.connectedAccountId,
      userId: metadata.userId,
      arguments: {
        max_results: 25,
        show_hidden: false,
        show_deleted: false,
      },
    });

    const calendarsData = asRecord(calendarsResult.data);
    const calendars = asRecordArray(calendarsData.items);
    const rows: UpsertPersonalContextItemInput[] = [];
    const timeMin = new Date(Date.parse(syncedAt) - 1000 * 60 * 60 * 24 * 90).toISOString();
    const timeMax = new Date(Date.parse(syncedAt) + 1000 * 60 * 60 * 24 * 30).toISOString();

    for (const calendar of calendars) {
      const calendarId = stringOrNull(calendar.id) ?? "primary";
      const eventsResult = await executor.execute("GOOGLECALENDAR_EVENTS_LIST", {
        connectedAccountId: source.connectedAccountId,
        userId: metadata.userId,
        arguments: {
          calendarId,
          maxResults: 100,
          singleEvents: true,
          orderBy: "startTime",
          timeMin,
          timeMax,
          showDeleted: false,
        },
      });
      const eventsData = asRecord(eventsResult.data);
      const events = asRecordArray(eventsData.items);

      for (const event of events) {
        const normalized = normalizeGoogleCalendarEvent(source, calendar, event);
        if (!normalized) {
          continue;
        }

        rows.push({
          id: normalized.id,
          sourceId: normalized.sourceId,
          userId: normalized.userId,
          toolkit: normalized.toolkit,
          itemType: normalized.itemType,
          externalId: normalized.externalId,
          externalParentId: normalized.externalParentId,
          title: normalized.title,
          contentText: normalized.contentText,
          url: normalized.url,
          occurredAt: normalized.occurredAt,
          syncedAt,
          contentHash: buildContentHash(
            JSON.stringify({
              title: normalized.title,
              contentText: normalized.contentText,
              attributes: normalized.attributes,
            }),
          ),
          attributesJson: JSON.stringify(normalized.attributes),
          rawJson: JSON.stringify(normalized.raw),
          searchText: normalized.searchText,
          isDeleted: false,
        });
      }
    }

    return rows;
  },
};

const syncSpecs = new Map<string, PersonalSyncSpec>([
  [gmailSyncSpec.toolkit, gmailSyncSpec],
  [googleCalendarSyncSpec.toolkit, googleCalendarSyncSpec],
  ["google_calendar", googleCalendarSyncSpec],
  ["google-calendar", googleCalendarSyncSpec],
]);

export const getPersonalSyncSpec = (
  toolkit: string,
): PersonalSyncSpec | null => syncSpecs.get(toolkit) ?? null;

export const isPersonalSyncSupported = (toolkit: string): boolean =>
  syncSpecs.has(toolkit);

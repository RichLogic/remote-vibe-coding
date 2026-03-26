import '../json/json_helpers.dart';

class ApiModelOption {
  const ApiModelOption({
    required this.id,
    required this.displayName,
    required this.model,
    required this.description,
    required this.isDefault,
    required this.hidden,
    required this.defaultReasoningEffort,
    required this.supportedReasoningEfforts,
  });

  final String id;
  final String displayName;
  final String model;
  final String description;
  final bool isDefault;
  final bool hidden;
  final String defaultReasoningEffort;
  final List<String> supportedReasoningEfforts;

  factory ApiModelOption.fromJson(Map<String, dynamic> json) {
    return ApiModelOption(
      id: readString(json, 'id'),
      displayName: readString(json, 'displayName'),
      model: readString(json, 'model'),
      description: readString(json, 'description'),
      isDefault: readBool(json, 'isDefault'),
      hidden: readBool(json, 'hidden'),
      defaultReasoningEffort: readString(json, 'defaultReasoningEffort'),
      supportedReasoningEfforts: readStringList(
        json,
        'supportedReasoningEfforts',
      ),
    );
  }
}

class PendingApproval {
  const PendingApproval({
    required this.id,
    required this.sessionId,
    required this.method,
    required this.title,
    required this.risk,
    required this.scopeOptions,
    required this.createdAt,
  });

  final String id;
  final String sessionId;
  final String method;
  final String title;
  final String risk;
  final List<String> scopeOptions;
  final String createdAt;

  factory PendingApproval.fromJson(Map<String, dynamic> json) {
    return PendingApproval(
      id: readString(json, 'id'),
      sessionId: readString(json, 'sessionId'),
      method: readString(json, 'method'),
      title: readString(json, 'title'),
      risk: readString(json, 'risk'),
      scopeOptions: readStringList(json, 'scopeOptions'),
      createdAt: readString(json, 'createdAt'),
    );
  }
}

class AttachmentSummary {
  const AttachmentSummary({
    required this.id,
    required this.kind,
    required this.filename,
    required this.mimeType,
    required this.sizeBytes,
    required this.url,
    required this.createdAt,
  });

  final String id;
  final String kind;
  final String filename;
  final String mimeType;
  final int sizeBytes;
  final String url;
  final String createdAt;

  factory AttachmentSummary.fromJson(Map<String, dynamic> json) {
    return AttachmentSummary(
      id: readString(json, 'id'),
      kind: readString(json, 'kind'),
      filename: readString(json, 'filename'),
      mimeType: readString(json, 'mimeType'),
      sizeBytes: readInt(json, 'sizeBytes'),
      url: readString(json, 'url'),
      createdAt: readString(json, 'createdAt'),
    );
  }
}

class SessionFileChange {
  const SessionFileChange({
    required this.path,
    required this.kind,
    required this.diff,
  });

  final String path;
  final String kind;
  final String? diff;

  factory SessionFileChange.fromJson(Map<String, dynamic> json) {
    return SessionFileChange(
      path: readString(json, 'path'),
      kind: readString(json, 'kind'),
      diff: readNullableString(json, 'diff'),
    );
  }
}

class TranscriptEntry {
  const TranscriptEntry({
    required this.id,
    required this.index,
    required this.kind,
    required this.body,
    required this.markdown,
    required this.label,
    required this.title,
    required this.meta,
    required this.attachments,
    required this.fileChanges,
  });

  final String id;
  final int index;
  final String kind;
  final String body;
  final bool markdown;
  final String? label;
  final String? title;
  final String? meta;
  final List<AttachmentSummary> attachments;
  final List<SessionFileChange> fileChanges;

  factory TranscriptEntry.fromJson(Map<String, dynamic> json) {
    return TranscriptEntry(
      id: readString(json, 'id'),
      index: readInt(json, 'index'),
      kind: readString(json, 'kind'),
      body: readString(json, 'body'),
      markdown: readBool(json, 'markdown'),
      label: readNullableString(json, 'label'),
      title: readNullableString(json, 'title'),
      meta: readNullableString(json, 'meta'),
      attachments: readObjectList(
        json,
        'attachments',
        AttachmentSummary.fromJson,
      ),
      fileChanges: readObjectList(
        json,
        'fileChanges',
        SessionFileChange.fromJson,
      ),
    );
  }
}

class SessionEvent {
  const SessionEvent({
    required this.id,
    required this.method,
    required this.summary,
    required this.createdAt,
  });

  final String id;
  final String method;
  final String summary;
  final String createdAt;

  factory SessionEvent.fromJson(Map<String, dynamic> json) {
    return SessionEvent(
      id: readString(json, 'id'),
      method: readString(json, 'method'),
      summary: readString(json, 'summary'),
      createdAt: readString(json, 'createdAt'),
    );
  }
}

class TranscriptPage {
  const TranscriptPage({
    required this.items,
    required this.nextCursor,
    required this.total,
  });

  final List<TranscriptEntry> items;
  final String? nextCursor;
  final int total;

  factory TranscriptPage.fromJson(Map<String, dynamic> json) {
    return TranscriptPage(
      items: readObjectList(
        json,
        'items',
        TranscriptEntry.fromJson,
      ),
      nextCursor: readNullableString(json, 'nextCursor'),
      total: readInt(json, 'total'),
    );
  }
}

class SessionCommandEvent {
  const SessionCommandEvent({
    required this.id,
    required this.index,
    required this.command,
    required this.cwd,
    required this.status,
    required this.exitCode,
    required this.output,
  });

  final String id;
  final int index;
  final String command;
  final String cwd;
  final String status;
  final int? exitCode;
  final String output;

  factory SessionCommandEvent.fromJson(Map<String, dynamic> json) {
    return SessionCommandEvent(
      id: readString(json, 'id'),
      index: readInt(json, 'index'),
      command: readString(json, 'command'),
      cwd: readString(json, 'cwd'),
      status: readString(json, 'status'),
      exitCode: json['exitCode'] is num ? (json['exitCode'] as num).toInt() : null,
      output: readString(json, 'output'),
    );
  }
}

class SessionFileChangeEvent {
  const SessionFileChangeEvent({
    required this.id,
    required this.index,
    required this.path,
    required this.kind,
    required this.status,
    required this.diff,
  });

  final String id;
  final int index;
  final String path;
  final String kind;
  final String status;
  final String? diff;

  factory SessionFileChangeEvent.fromJson(Map<String, dynamic> json) {
    return SessionFileChangeEvent(
      id: readString(json, 'id'),
      index: readInt(json, 'index'),
      path: readString(json, 'path'),
      kind: readString(json, 'kind'),
      status: readString(json, 'status'),
      diff: readNullableString(json, 'diff'),
    );
  }
}

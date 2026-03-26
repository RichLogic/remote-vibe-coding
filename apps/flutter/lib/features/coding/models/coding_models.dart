import '../../../core/json/json_helpers.dart';
import '../../../core/models/common_models.dart';
import '../../../core/session/user_session.dart';

class CodingWorkspace {
  const CodingWorkspace({
    required this.id,
    required this.name,
    required this.path,
    required this.visible,
    required this.sortOrder,
  });

  final String id;
  final String name;
  final String path;
  final bool visible;
  final int sortOrder;

  factory CodingWorkspace.fromJson(Map<String, dynamic> json) {
    return CodingWorkspace(
      id: readString(json, 'id'),
      name: readString(json, 'name'),
      path: readString(json, 'path'),
      visible: readBool(json, 'visible', fallback: true),
      sortOrder: readInt(json, 'sortOrder'),
    );
  }
}

class CodingSession {
  const CodingSession({
    required this.id,
    required this.sessionType,
    required this.threadId,
    required this.ownerUsername,
    required this.title,
    required this.autoTitle,
    required this.workspaceId,
    required this.workspace,
    required this.archivedAt,
    required this.status,
    required this.activeTurnId,
    required this.securityProfile,
    required this.approvalMode,
    required this.networkEnabled,
    required this.fullHostEnabled,
    required this.pendingApprovalCount,
    required this.lastUpdate,
    required this.lastIssue,
    required this.hasTranscript,
    required this.model,
    required this.reasoningEffort,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  final String sessionType;
  final String threadId;
  final String ownerUsername;
  final String title;
  final bool autoTitle;
  final String workspaceId;
  final String workspace;
  final String? archivedAt;
  final String status;
  final String? activeTurnId;
  final String securityProfile;
  final String approvalMode;
  final bool networkEnabled;
  final bool fullHostEnabled;
  final int pendingApprovalCount;
  final String? lastUpdate;
  final String? lastIssue;
  final bool hasTranscript;
  final String? model;
  final String? reasoningEffort;
  final String createdAt;
  final String updatedAt;

  bool get needsApproval => status == 'needs-approval' || pendingApprovalCount > 0;

  factory CodingSession.fromJson(Map<String, dynamic> json) {
    return CodingSession(
      id: readString(json, 'id'),
      sessionType: readString(json, 'sessionType', fallback: 'code'),
      threadId: readString(json, 'threadId'),
      ownerUsername: readString(json, 'ownerUsername'),
      title: readString(json, 'title'),
      autoTitle: readBool(json, 'autoTitle'),
      workspaceId: readString(json, 'workspaceId'),
      workspace: readString(json, 'workspace'),
      archivedAt: readNullableString(json, 'archivedAt'),
      status: readString(json, 'status'),
      activeTurnId: readNullableString(json, 'activeTurnId'),
      securityProfile: readString(json, 'securityProfile'),
      approvalMode: readString(json, 'approvalMode'),
      networkEnabled: readBool(json, 'networkEnabled'),
      fullHostEnabled: readBool(json, 'fullHostEnabled'),
      pendingApprovalCount: readInt(json, 'pendingApprovalCount'),
      lastUpdate: readNullableString(json, 'lastUpdate'),
      lastIssue: readNullableString(json, 'lastIssue'),
      hasTranscript: readBool(json, 'hasTranscript'),
      model: readNullableString(json, 'model'),
      reasoningEffort: readNullableString(json, 'reasoningEffort'),
      createdAt: readString(json, 'createdAt'),
      updatedAt: readString(json, 'updatedAt'),
    );
  }
}

class CodingBootstrap {
  const CodingBootstrap({
    required this.productName,
    required this.subtitle,
    required this.user,
    required this.workspaceRoot,
    required this.workspaces,
    required this.sessions,
    required this.approvals,
    required this.availableModels,
    required this.defaultModel,
    required this.defaultReasoningEffort,
    required this.updatedAt,
  });

  final String productName;
  final String subtitle;
  final AuthenticatedUser user;
  final String workspaceRoot;
  final List<CodingWorkspace> workspaces;
  final List<CodingSession> sessions;
  final List<PendingApproval> approvals;
  final List<ApiModelOption> availableModels;
  final String defaultModel;
  final String defaultReasoningEffort;
  final String updatedAt;

  factory CodingBootstrap.fromJson(Map<String, dynamic> json) {
    final Map<String, dynamic> defaults = asJsonMap(json['defaults']);
    return CodingBootstrap(
      productName: readString(json, 'productName'),
      subtitle: readString(json, 'subtitle'),
      user: AuthenticatedUser.fromJson(asJsonMap(json['currentUser'])),
      workspaceRoot: readString(json, 'workspaceRoot'),
      workspaces: readObjectList(
        json,
        'workspaces',
        CodingWorkspace.fromJson,
      ),
      sessions: readObjectList(
        json,
        'sessions',
        CodingSession.fromJson,
      ),
      approvals: readObjectList(
        json,
        'approvals',
        PendingApproval.fromJson,
      ),
      availableModels: readObjectList(
        json,
        'availableModels',
        ApiModelOption.fromJson,
      ),
      defaultModel: readString(defaults, 'model'),
      defaultReasoningEffort: readString(defaults, 'reasoningEffort'),
      updatedAt: readString(json, 'updatedAt'),
    );
  }
}

class CodingSessionDetail {
  const CodingSessionDetail({
    required this.session,
    required this.approvals,
    required this.liveEvents,
    required this.thread,
    required this.transcriptTotal,
    required this.commands,
    required this.changes,
    required this.draftAttachments,
  });

  final CodingSession session;
  final List<PendingApproval> approvals;
  final List<SessionEvent> liveEvents;
  final CodingThreadSummary? thread;
  final int transcriptTotal;
  final List<SessionCommandEvent> commands;
  final List<SessionFileChangeEvent> changes;
  final List<AttachmentSummary> draftAttachments;

  factory CodingSessionDetail.fromJson(Map<String, dynamic> json) {
    return CodingSessionDetail(
      session: CodingSession.fromJson(asJsonMap(json['session'])),
      approvals: readObjectList(
        json,
        'approvals',
        PendingApproval.fromJson,
      ),
      liveEvents: readObjectList(
        json,
        'liveEvents',
        SessionEvent.fromJson,
      ),
      thread: json['thread'] == null
          ? null
          : CodingThreadSummary.fromJson(asJsonMap(json['thread'])),
      transcriptTotal: readInt(json, 'transcriptTotal'),
      commands: readObjectList(
        json,
        'commands',
        SessionCommandEvent.fromJson,
      ),
      changes: readObjectList(
        json,
        'changes',
        SessionFileChangeEvent.fromJson,
      ),
      draftAttachments: readObjectList(
        json,
        'draftAttachments',
        AttachmentSummary.fromJson,
      ),
    );
  }
}

class CodingThreadSummary {
  const CodingThreadSummary({
    required this.id,
    required this.preview,
    required this.cwd,
    required this.name,
    required this.path,
    required this.cliVersion,
    required this.source,
    required this.modelProvider,
    required this.statusType,
    required this.activeFlags,
    required this.updatedAt,
  });

  final String id;
  final String preview;
  final String cwd;
  final String? name;
  final String? path;
  final String? cliVersion;
  final String? source;
  final String? modelProvider;
  final String statusType;
  final List<String> activeFlags;
  final int updatedAt;

  factory CodingThreadSummary.fromJson(Map<String, dynamic> json) {
    final dynamic rawStatus = json['status'];
    final Map<String, dynamic> statusMap = rawStatus is Map
        ? asJsonMap(rawStatus)
        : const <String, dynamic>{};
    return CodingThreadSummary(
      id: readString(json, 'id'),
      preview: readString(json, 'preview'),
      cwd: readString(json, 'cwd'),
      name: readNullableString(json, 'name'),
      path: readNullableString(json, 'path'),
      cliVersion: readNullableString(json, 'cliVersion'),
      source: readNullableString(json, 'source'),
      modelProvider: readNullableString(json, 'modelProvider'),
      statusType: rawStatus is String
          ? rawStatus
          : readString(statusMap, 'type', fallback: 'unknown'),
      activeFlags: rawStatus is String
          ? const <String>[]
          : readStringList(statusMap, 'activeFlags'),
      updatedAt: json['updatedAt'] is num ? (json['updatedAt'] as num).toInt() : 0,
    );
  }
}

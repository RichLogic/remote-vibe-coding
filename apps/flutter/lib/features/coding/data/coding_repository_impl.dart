import '../../../core/files/attachment_picker.dart';
import '../../../core/http/api_client.dart';
import '../../../core/json/json_helpers.dart';
import '../../../core/models/common_models.dart';
import '../models/coding_models.dart';
import '../models/workspace_models.dart';
import 'coding_repository.dart';

class ApiCodingRepository implements CodingRepository {
  ApiCodingRepository(this._apiClient);

  final ApiClient _apiClient;

  @override
  Future<CodingSession> createSession(
    String workspaceId, {
    String? title,
    String? model,
    String? reasoningEffort,
    String? securityProfile,
    String? approvalMode,
  }) async {
    final dynamic response = await _apiClient.postJson(
      '/api/coding/workspaces/$workspaceId/sessions',
      body: <String, dynamic>{
        if (title != null && title.trim().isNotEmpty) 'title': title.trim(),
        if (model != null && model.trim().isNotEmpty) 'model': model.trim(),
        if (reasoningEffort != null && reasoningEffort.trim().isNotEmpty)
          'reasoningEffort': reasoningEffort.trim(),
        if (securityProfile != null && securityProfile.trim().isNotEmpty)
          'securityProfile': securityProfile.trim(),
        if (approvalMode != null && approvalMode.trim().isNotEmpty)
          'approvalMode': approvalMode.trim(),
      },
    );
    final Map<String, dynamic> payload = asJsonMap(response);
    return CodingSession.fromJson(asJsonMap(payload['session']));
  }

  @override
  Future<CodingWorkspaceMutationResult> createWorkspace({
    required String source,
    String? name,
    String? gitUrl,
  }) async {
    final Map<String, dynamic> payload = await _apiClient.postJson(
      '/api/coding/workspaces',
      body: <String, dynamic>{
        'source': source,
        if (name != null && name.trim().isNotEmpty) 'name': name.trim(),
        if (gitUrl != null && gitUrl.trim().isNotEmpty) 'gitUrl': gitUrl.trim(),
      },
    );
    return CodingWorkspaceMutationResult.fromJson(payload);
  }

  @override
  Future<void> deleteAttachment(String sessionId, String attachmentId) async {
    await _apiClient.deleteJson(
      '/api/coding/sessions/$sessionId/attachments/$attachmentId',
    );
  }

  @override
  Future<CodingSession> forkSession(String sessionId) async {
    final dynamic response = await _apiClient.postJson(
      '/api/coding/sessions/$sessionId/fork',
      body: const <String, dynamic>{},
    );
    final Map<String, dynamic> payload = asJsonMap(response);
    return CodingSession.fromJson(asJsonMap(payload['session']));
  }

  @override
  Future<CodingBootstrap> fetchBootstrap() async {
    final Map<String, dynamic> payload = await _apiClient.getJson(
      '/api/coding/bootstrap',
    );
    return CodingBootstrap.fromJson(payload);
  }

  @override
  Future<CodingSessionDetail> fetchSessionDetail(String sessionId) async {
    final Map<String, dynamic> payload = await _apiClient.getJson(
      '/api/coding/sessions/$sessionId',
    );
    return CodingSessionDetail.fromJson(payload);
  }

  @override
  Future<TranscriptPage> fetchTranscript(
    String sessionId, {
    int limit = 50,
    String? before,
  }) async {
    final Map<String, dynamic> payload = await _apiClient.getJson(
      '/api/coding/sessions/$sessionId/transcript',
      query: <String, String?>{
        'limit': '$limit',
        'before': before,
      },
    );
    return TranscriptPage.fromJson(payload);
  }

  @override
  Future<CodingSession> restartSession(String sessionId) async {
    final dynamic response = await _apiClient.postJson(
      '/api/coding/sessions/$sessionId/restart',
      body: const <String, dynamic>{},
    );
    final Map<String, dynamic> payload = asJsonMap(response);
    return CodingSession.fromJson(asJsonMap(payload['session']));
  }

  @override
  Future<void> resolveApproval(
    String sessionId,
    String approvalId, {
    required String decision,
    String scope = 'once',
  }) async {
    await _apiClient.postJson(
      '/api/coding/sessions/$sessionId/approvals/$approvalId',
      body: <String, dynamic>{
        'decision': decision,
        'scope': scope,
      },
    );
  }

  @override
  Future<CodingSession> stopSession(String sessionId) async {
    final dynamic response = await _apiClient.postJson(
      '/api/coding/sessions/$sessionId/stop',
      body: const <String, dynamic>{},
    );
    final Map<String, dynamic> payload = asJsonMap(response);
    return CodingSession.fromJson(asJsonMap(payload['session']));
  }

  @override
  Future<void> startTurn(
    String sessionId, {
    String? prompt,
    List<String> attachmentIds = const <String>[],
  }) async {
    await _apiClient.postJson(
      '/api/coding/sessions/$sessionId/turns',
      body: <String, dynamic>{
        if (prompt != null && prompt.trim().isNotEmpty) 'prompt': prompt.trim(),
        if (attachmentIds.isNotEmpty) 'attachmentIds': attachmentIds,
      },
    );
  }

  @override
  Future<CodingSession> archiveSession(String sessionId) async {
    final dynamic response = await _apiClient.postJson(
      '/api/coding/sessions/$sessionId/archive',
      body: const <String, dynamic>{},
    );
    final Map<String, dynamic> payload = asJsonMap(response);
    return CodingSession.fromJson(asJsonMap(payload['session']));
  }

  @override
  Future<void> deleteSession(String sessionId) async {
    await _apiClient.deleteJson('/api/coding/sessions/$sessionId');
  }

  @override
  Future<CodingSession> restoreSession(String sessionId) async {
    final dynamic response = await _apiClient.postJson(
      '/api/coding/sessions/$sessionId/restore',
      body: const <String, dynamic>{},
    );
    final Map<String, dynamic> payload = asJsonMap(response);
    return CodingSession.fromJson(asJsonMap(payload['session']));
  }

  @override
  Future<CodingWorkspaceMutationResult> reorderWorkspaces(List<String> workspaceIds) async {
    final Map<String, dynamic> payload = await _apiClient.postJson(
      '/api/coding/workspaces/reorder',
      body: <String, dynamic>{
        'workspaceIds': workspaceIds,
      },
    );
    return CodingWorkspaceMutationResult.fromJson(payload);
  }

  @override
  Future<CodingSession> updateSession(
    String sessionId, {
    String? title,
    String? workspaceName,
    String? securityProfile,
  }) async {
    final Map<String, dynamic> payload = await _apiClient.patchJson(
      '/api/coding/sessions/$sessionId',
      body: <String, dynamic>{
        if (title != null) 'title': title,
        if (workspaceName != null && workspaceName.trim().isNotEmpty)
          'workspaceName': workspaceName.trim(),
        if (securityProfile != null && securityProfile.trim().isNotEmpty)
          'securityProfile': securityProfile.trim(),
      },
    );
    return CodingSession.fromJson(asJsonMap(payload['session']));
  }

  @override
  Future<CodingSession> updateSessionPreferences(
    String sessionId, {
    String? model,
    String? reasoningEffort,
    String? approvalMode,
  }) async {
    final Map<String, dynamic> payload = await _apiClient.patchJson(
      '/api/coding/sessions/$sessionId/preferences',
      body: <String, dynamic>{
        if (model != null && model.trim().isNotEmpty) 'model': model.trim(),
        if (reasoningEffort != null && reasoningEffort.trim().isNotEmpty)
          'reasoningEffort': reasoningEffort.trim(),
        if (approvalMode != null && approvalMode.trim().isNotEmpty)
          'approvalMode': approvalMode.trim(),
      },
    );
    return CodingSession.fromJson(asJsonMap(payload['session']));
  }

  @override
  Future<CodingWorkspaceMutationResult> updateWorkspaceVisibility(
    String workspaceId, {
    required bool visible,
  }) async {
    final Map<String, dynamic> payload = await _apiClient.patchJson(
      '/api/coding/workspaces/$workspaceId',
      body: <String, dynamic>{
        'visible': visible,
      },
    );
    return CodingWorkspaceMutationResult.fromJson(payload);
  }

  @override
  Future<AttachmentSummary> uploadAttachment(
    String sessionId,
    AttachmentUploadInput attachment,
  ) async {
    final dynamic response = await _apiClient.postMultipartFile(
      '/api/coding/sessions/$sessionId/attachments',
      fieldName: 'file',
      filename: attachment.filename,
      bytes: attachment.bytes,
      mimeType: attachment.mimeType,
    );
    final Map<String, dynamic> payload = asJsonMap(response);
    return AttachmentSummary.fromJson(asJsonMap(payload['attachment']));
  }
}

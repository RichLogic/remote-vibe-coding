import '../../../core/files/attachment_picker.dart';
import '../../../core/models/common_models.dart';
import '../models/coding_models.dart';
import '../models/workspace_models.dart';

abstract class CodingRepository {
  Future<CodingBootstrap> fetchBootstrap();

  Future<CodingSessionDetail> fetchSessionDetail(String sessionId);

  Future<TranscriptPage> fetchTranscript(
    String sessionId, {
    int limit = 50,
    String? before,
  });

  Future<CodingSession> createSession(
    String workspaceId, {
    String? title,
    String? model,
    String? reasoningEffort,
    String? securityProfile,
    String? approvalMode,
  });

  Future<CodingSession> updateSession(
    String sessionId, {
    String? title,
    String? workspaceName,
    String? securityProfile,
  });

  Future<CodingSession> updateSessionPreferences(
    String sessionId, {
    String? model,
    String? reasoningEffort,
    String? approvalMode,
  });

  Future<CodingSession> forkSession(String sessionId);

  Future<CodingSession> restartSession(String sessionId);

  Future<CodingSession> stopSession(String sessionId);

  Future<CodingSession> archiveSession(String sessionId);

  Future<CodingSession> restoreSession(String sessionId);

  Future<void> deleteSession(String sessionId);

  Future<AttachmentSummary> uploadAttachment(
    String sessionId,
    AttachmentUploadInput attachment,
  );

  Future<void> deleteAttachment(String sessionId, String attachmentId);

  Future<CodingWorkspaceMutationResult> createWorkspace({
    required String source,
    String? name,
    String? gitUrl,
  });

  Future<CodingWorkspaceMutationResult> updateWorkspaceVisibility(
    String workspaceId, {
    required bool visible,
  });

  Future<CodingWorkspaceMutationResult> reorderWorkspaces(List<String> workspaceIds);

  Future<void> startTurn(
    String sessionId, {
    String? prompt,
    List<String> attachmentIds,
  });

  Future<void> resolveApproval(
    String sessionId,
    String approvalId, {
    required String decision,
    String scope,
  });
}

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../../core/files/attachment_picker.dart';
import '../../../core/models/common_models.dart';
import '../data/coding_repository.dart';
import '../models/coding_models.dart';

class CodingController extends ChangeNotifier {
  CodingController(this._repository);

  final CodingRepository _repository;

  CodingBootstrap? _bootstrap;
  CodingSessionDetail? _detail;
  TranscriptPage? _transcript;
  String? _selectedWorkspaceId;
  String? _selectedSessionId;
  bool _loadingBootstrap = false;
  bool _loadingDetail = false;
  bool _loadingOlderTranscript = false;
  bool _mutating = false;
  String? _error;
  Timer? _pollTimer;

  CodingBootstrap? get bootstrap => _bootstrap;
  CodingSessionDetail? get detail => _detail;
  TranscriptPage? get transcript => _transcript;
  String? get selectedWorkspaceId => _selectedWorkspaceId;
  String? get selectedSessionId => _selectedSessionId;
  bool get loadingBootstrap => _loadingBootstrap;
  bool get loadingDetail => _loadingDetail;
  bool get loadingOlderTranscript => _loadingOlderTranscript;
  bool get mutating => _mutating;
  String? get error => _error;

  CodingWorkspace? get selectedWorkspace {
    final CodingBootstrap? current = _bootstrap;
    final String? workspaceId = _selectedWorkspaceId;
    if (current == null || workspaceId == null) {
      return null;
    }
    for (final CodingWorkspace workspace in current.workspaces) {
      if (workspace.id == workspaceId) {
        return workspace;
      }
    }
    return null;
  }

  List<ApiModelOption> get availableModels {
    return _bootstrap?.availableModels ?? const <ApiModelOption>[];
  }

  CodingSession? get selectedSessionSummary {
    final CodingBootstrap? current = _bootstrap;
    final String? sessionId = _selectedSessionId;
    if (current == null || sessionId == null) {
      return null;
    }
    for (final CodingSession session in current.sessions) {
      if (session.id == sessionId) {
        return session;
      }
    }
    return null;
  }

  bool get canLoadOlderTranscript {
    final TranscriptPage? current = _transcript;
    return current != null &&
        current.nextCursor != null &&
        current.nextCursor!.isNotEmpty;
  }

  List<CodingSession> get filteredSessions {
    final CodingBootstrap? current = _bootstrap;
    if (current == null) {
      return const <CodingSession>[];
    }
    if (_selectedWorkspaceId == null) {
      return current.sessions;
    }
    return current.sessions
        .where((CodingSession session) => session.workspaceId == _selectedWorkspaceId)
        .toList(growable: false);
  }

  List<String> supportedReasoningEffortsForModel(String? model) {
    final ApiModelOption? option = modelOptionFor(model);
    if (option == null) {
      return const <String>['minimal', 'low', 'medium', 'high', 'xhigh'];
    }
    return option.supportedReasoningEfforts;
  }

  String preferredReasoningEffortForModel(String? model) {
    final ApiModelOption? option = modelOptionFor(model);
    if (option != null) {
      return option.defaultReasoningEffort;
    }
    return _bootstrap?.defaultReasoningEffort ?? 'high';
  }

  ApiModelOption? modelOptionFor(String? model) {
    final CodingBootstrap? current = _bootstrap;
    if (current == null) {
      return null;
    }

    final String nextModel = (model != null && model.trim().isNotEmpty)
        ? model.trim()
        : current.defaultModel;
    for (final ApiModelOption option in current.availableModels) {
      if (option.model == nextModel) {
        return option;
      }
    }
    return null;
  }

  Future<void> loadBootstrap() async {
    if (_loadingBootstrap) {
      return;
    }

    _loadingBootstrap = true;
    _error = null;
    notifyListeners();

    try {
      _bootstrap = await _repository.fetchBootstrap();
      _syncSelection();
      await _loadSelectedSession(notify: false);
    } catch (error) {
      _error = error.toString();
    } finally {
      _loadingBootstrap = false;
      notifyListeners();
    }
  }

  Future<void> refresh() async {
    await loadBootstrap();
  }

  Future<void> selectWorkspace(String? workspaceId) async {
    _selectedWorkspaceId = workspaceId;
    _syncSelection();
    notifyListeners();
    await _loadSelectedSession();
  }

  Future<void> selectSession(String sessionId) async {
    if (_selectedSessionId == sessionId) {
      return;
    }
    _selectedSessionId = sessionId;
    notifyListeners();
    await _loadSelectedSession();
  }

  Future<void> createWorkspace({
    required String source,
    String? name,
    String? gitUrl,
  }) async {
    await _runMutation(() async {
      final result = await _repository.createWorkspace(
        source: source,
        name: name,
        gitUrl: gitUrl,
      );
      _selectedWorkspaceId = result.workspace?.id ?? _selectedWorkspaceId;
      _selectedSessionId = null;
      await loadBootstrap();
    });
  }

  Future<void> setWorkspaceVisibility(
    String workspaceId, {
    required bool visible,
  }) async {
    await _runMutation(() async {
      await _repository.updateWorkspaceVisibility(
        workspaceId,
        visible: visible,
      );
      await loadBootstrap();
    });
  }

  Future<void> moveWorkspace(
    String workspaceId, {
    required int direction,
  }) async {
    final CodingBootstrap? current = _bootstrap;
    if (current == null || direction == 0) {
      return;
    }

    final List<CodingWorkspace> ordered = <CodingWorkspace>[
      ...current.workspaces,
    ]..sort((CodingWorkspace left, CodingWorkspace right) {
        return left.sortOrder.compareTo(right.sortOrder);
      });
    final int index = ordered.indexWhere(
      (CodingWorkspace workspace) => workspace.id == workspaceId,
    );
    if (index < 0) {
      return;
    }

    final int nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= ordered.length) {
      return;
    }

    final CodingWorkspace currentWorkspace = ordered[index];
    ordered[index] = ordered[nextIndex];
    ordered[nextIndex] = currentWorkspace;

    await _runMutation(() async {
      await _repository.reorderWorkspaces(
        ordered.map((CodingWorkspace workspace) => workspace.id).toList(growable: false),
      );
      await loadBootstrap();
    });
  }

  Future<void> createSession({
    String? title,
    String? model,
    String? reasoningEffort,
    String? securityProfile,
    String? approvalMode,
  }) async {
    final String? workspaceId = _selectedWorkspaceId;
    if (workspaceId == null) {
      return;
    }
    await _runMutation(() async {
      final CodingSession session = await _repository.createSession(
        workspaceId,
        title: title,
        model: model,
        reasoningEffort: reasoningEffort,
        securityProfile: securityProfile,
        approvalMode: approvalMode,
      );
      _selectedSessionId = session.id;
      await loadBootstrap();
    });
  }

  Future<void> saveSelectedSessionSettings({
    required String title,
    required String workspaceId,
    required String securityProfile,
    required String approvalMode,
    required String model,
    required String reasoningEffort,
  }) async {
    final CodingSessionDetail? currentDetail = _detail;
    final String? sessionId = _selectedSessionId;
    if (currentDetail == null || sessionId == null) {
      return;
    }

    final CodingWorkspace? workspace = _workspaceById(workspaceId);
    if (workspace == null) {
      return;
    }

    final CodingSession session = currentDetail.session;
    final String nextTitle = title.trim().isEmpty ? session.title : title.trim();
    final String nextModel = model.trim().isEmpty
        ? (session.model ?? _bootstrap?.defaultModel ?? '')
        : model.trim();
    final String nextEffort = reasoningEffort.trim().isEmpty
        ? preferredReasoningEffortForModel(nextModel)
        : reasoningEffort.trim();

    final bool needsSessionUpdate = nextTitle != session.title ||
        workspaceId != session.workspaceId ||
        securityProfile != session.securityProfile;
    final bool needsPreferencesUpdate =
        nextModel != (session.model ?? _bootstrap?.defaultModel ?? '') ||
        nextEffort != (session.reasoningEffort ?? preferredReasoningEffortForModel(nextModel)) ||
        approvalMode != session.approvalMode;

    if (!needsSessionUpdate && !needsPreferencesUpdate) {
      return;
    }

    await _runMutation(() async {
      if (needsSessionUpdate) {
        _selectedWorkspaceId = workspaceId;
        await _repository.updateSession(
          sessionId,
          title: nextTitle,
          workspaceName: workspace.name,
          securityProfile: securityProfile,
        );
      }

      if (needsPreferencesUpdate) {
        await _repository.updateSessionPreferences(
          sessionId,
          model: nextModel,
          reasoningEffort: nextEffort,
          approvalMode: approvalMode,
        );
      }

      await loadBootstrap();
    });
  }

  Future<void> uploadAttachments(List<AttachmentUploadInput> attachments) async {
    final String? sessionId = _selectedSessionId;
    if (sessionId == null || attachments.isEmpty) {
      return;
    }

    await _runMutation(() async {
      for (final AttachmentUploadInput attachment in attachments) {
        await _repository.uploadAttachment(sessionId, attachment);
      }
      await _loadSelectedSession(notify: false);
    });
  }

  Future<void> removeDraftAttachment(String attachmentId) async {
    final String? sessionId = _selectedSessionId;
    if (sessionId == null || attachmentId.isEmpty) {
      return;
    }

    await _runMutation(() async {
      await _repository.deleteAttachment(sessionId, attachmentId);
      await _loadSelectedSession(notify: false);
    });
  }

  Future<void> startTurn(
    String prompt, {
    List<String> attachmentIds = const <String>[],
  }) async {
    final String? sessionId = _selectedSessionId;
    final String trimmedPrompt = prompt.trim();
    if (sessionId == null || (trimmedPrompt.isEmpty && attachmentIds.isEmpty)) {
      return;
    }
    await _runMutation(() async {
      await _repository.startTurn(
        sessionId,
        prompt: trimmedPrompt,
        attachmentIds: attachmentIds,
      );
      await loadBootstrap();
    });
  }

  Future<void> resolveApproval(
    String approvalId, {
    required String decision,
    String scope = 'once',
  }) async {
    final String? sessionId = _selectedSessionId;
    if (sessionId == null) {
      return;
    }
    await _runMutation(() async {
      await _repository.resolveApproval(
        sessionId,
        approvalId,
        decision: decision,
        scope: scope,
      );
      await loadBootstrap();
    });
  }

  Future<void> stopSelectedSession() async {
    final String? sessionId = _selectedSessionId;
    if (sessionId == null) {
      return;
    }
    await _runMutation(() async {
      await _repository.stopSession(sessionId);
      await loadBootstrap();
    });
  }

  Future<void> restartSelectedSession() async {
    final String? sessionId = _selectedSessionId;
    if (sessionId == null) {
      return;
    }
    await _runMutation(() async {
      await _repository.restartSession(sessionId);
      await loadBootstrap();
    });
  }

  Future<void> forkSelectedSession() async {
    final String? sessionId = _selectedSessionId;
    if (sessionId == null) {
      return;
    }
    await _runMutation(() async {
      final CodingSession nextSession = await _repository.forkSession(sessionId);
      _selectedWorkspaceId = nextSession.workspaceId;
      _selectedSessionId = nextSession.id;
      await loadBootstrap();
    });
  }

  Future<void> archiveSelectedSession() async {
    final String? sessionId = _selectedSessionId;
    if (sessionId == null) {
      return;
    }
    await _runMutation(() async {
      await _repository.archiveSession(sessionId);
      await loadBootstrap();
    });
  }

  Future<void> restoreSelectedSession() async {
    final String? sessionId = _selectedSessionId;
    if (sessionId == null) {
      return;
    }
    await _runMutation(() async {
      await _repository.restoreSession(sessionId);
      await loadBootstrap();
    });
  }

  Future<void> deleteSelectedSession() async {
    final String? sessionId = _selectedSessionId;
    if (sessionId == null) {
      return;
    }
    await _runMutation(() async {
      await _repository.deleteSession(sessionId);
      _selectedSessionId = null;
      await loadBootstrap();
    });
  }

  Future<void> loadOlderTranscript() async {
    final String? sessionId = _selectedSessionId;
    final TranscriptPage? currentTranscript = _transcript;
    if (sessionId == null ||
        currentTranscript == null ||
        currentTranscript.nextCursor == null ||
        currentTranscript.nextCursor!.isEmpty ||
        _loadingOlderTranscript) {
      return;
    }

    _loadingOlderTranscript = true;
    _error = null;
    notifyListeners();

    try {
      final TranscriptPage nextPage = await _repository.fetchTranscript(
        sessionId,
        before: currentTranscript.nextCursor,
      );
      _transcript = TranscriptPage(
        items: _mergeTranscriptEntries(
          currentTranscript.items,
          nextPage.items,
        ),
        nextCursor: nextPage.nextCursor,
        total: nextPage.total,
      );
    } catch (error) {
      _error = error.toString();
    } finally {
      _loadingOlderTranscript = false;
      notifyListeners();
    }
  }

  void startPolling({
    Duration interval = const Duration(seconds: 5),
  }) {
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(interval, (_) {
      if (_loadingBootstrap || _loadingDetail || _mutating) {
        return;
      }
      unawaited(loadBootstrap());
    });
  }

  void stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  Future<void> _loadSelectedSession({
    bool notify = true,
  }) async {
    final String? sessionId = _selectedSessionId;
    if (sessionId == null) {
      _detail = null;
      _transcript = null;
      if (notify) {
        notifyListeners();
      }
      return;
    }

    _loadingDetail = true;
    if (notify) {
      notifyListeners();
    }

    try {
      _detail = await _repository.fetchSessionDetail(sessionId);
      _transcript = await _repository.fetchTranscript(sessionId);
      _error = null;
    } catch (error) {
      _error = error.toString();
    } finally {
      _loadingDetail = false;
      if (notify) {
        notifyListeners();
      }
    }
  }

  List<TranscriptEntry> _mergeTranscriptEntries(
    List<TranscriptEntry> current,
    List<TranscriptEntry> incoming,
  ) {
    final Map<int, TranscriptEntry> merged = <int, TranscriptEntry>{};
    for (final TranscriptEntry entry in current) {
      merged[entry.index] = entry;
    }
    for (final TranscriptEntry entry in incoming) {
      merged[entry.index] = entry;
    }
    final List<TranscriptEntry> items = merged.values.toList(growable: false);
    items.sort((TranscriptEntry left, TranscriptEntry right) {
      return left.index.compareTo(right.index);
    });
    return items;
  }

  Future<void> _runMutation(Future<void> Function() operation) async {
    _mutating = true;
    _error = null;
    notifyListeners();

    try {
      await operation();
    } catch (error) {
      _error = error.toString();
    } finally {
      _mutating = false;
      notifyListeners();
    }
  }

  CodingWorkspace? _workspaceById(String workspaceId) {
    final CodingBootstrap? current = _bootstrap;
    if (current == null) {
      return null;
    }
    for (final CodingWorkspace workspace in current.workspaces) {
      if (workspace.id == workspaceId) {
        return workspace;
      }
    }
    return null;
  }

  void _syncSelection() {
    final CodingBootstrap? current = _bootstrap;
    if (current == null) {
      _selectedWorkspaceId = null;
      _selectedSessionId = null;
      return;
    }

    final bool selectedWorkspaceExists = current.workspaces.any(
      (CodingWorkspace workspace) => workspace.id == _selectedWorkspaceId,
    );
    if (!selectedWorkspaceExists) {
      _selectedWorkspaceId = current.workspaces.isNotEmpty
          ? current.workspaces.first.id
          : null;
    }

    final List<CodingSession> sessions = filteredSessions;
    final bool selectedSessionExists = sessions.any(
      (CodingSession session) => session.id == _selectedSessionId,
    );
    if (!selectedSessionExists) {
      _selectedSessionId = sessions.isNotEmpty ? sessions.first.id : null;
    }
  }

  @override
  void dispose() {
    stopPolling();
    super.dispose();
  }
}

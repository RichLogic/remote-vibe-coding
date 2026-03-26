import 'package:flutter/material.dart';

import '../../../app/app_scope.dart';
import '../../../core/models/common_models.dart';
import '../application/coding_controller.dart';
import '../models/coding_models.dart';

enum _SessionAction {
  restart,
  fork,
  archive,
  restore,
  delete,
}

class CodingScreen extends StatefulWidget {
  const CodingScreen({super.key});

  @override
  State<CodingScreen> createState() => _CodingScreenState();
}

class _CodingScreenState extends State<CodingScreen> {
  late final TextEditingController _promptController;

  @override
  void initState() {
    super.initState();
    _promptController = TextEditingController();
  }

  @override
  void dispose() {
    _promptController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final AppScope scope = AppScope.of(context);
    final CodingController controller = scope.codingController;
    final bool canUseFullHost = scope.sessionController.user?.canUseFullHost ?? false;

    return AnimatedBuilder(
      animation: controller,
      builder: (BuildContext context, Widget? child) {
        final CodingBootstrap? bootstrap = controller.bootstrap;
        if (controller.loadingBootstrap && bootstrap == null) {
          return const Center(child: CircularProgressIndicator());
        }
        if (bootstrap == null) {
          return _EmptyState(
            message: controller.error ?? 'No coding data loaded yet.',
          );
        }

        final ThemeData theme = Theme.of(context);
        final List<CodingWorkspace> workspaces = <CodingWorkspace>[
          ...bootstrap.workspaces,
        ]..sort((CodingWorkspace left, CodingWorkspace right) {
            return left.sortOrder.compareTo(right.sortOrder);
          });
        final List<CodingSession> sessions = controller.filteredSessions;
        final CodingSessionDetail? detail = controller.detail;
        final CodingSession? selectedSession = detail?.session ?? controller.selectedSessionSummary;
        final TranscriptPage? transcript = controller.transcript;
        final List<AttachmentSummary> draftAttachments = detail?.draftAttachments ?? const <AttachmentSummary>[];
        final bool canSendPrompt = controller.selectedSessionId != null &&
            !controller.mutating &&
            (_promptController.text.trim().isNotEmpty || draftAttachments.isNotEmpty);

        return RefreshIndicator(
          onRefresh: controller.refresh,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(16),
            children: <Widget>[
              _SectionTitle(
                title: 'Coding',
                subtitle: bootstrap.subtitle,
              ),
              _InfoCard(
                title: bootstrap.user.username,
                body:
                    'Host workspace root: ${bootstrap.workspaceRoot}\nDefault model: ${bootstrap.defaultModel}\nDefault effort: ${bootstrap.defaultReasoningEffort}',
              ),
              const SizedBox(height: 16),
              _SectionTitle(
                title: 'Workspaces',
                subtitle: '${workspaces.length} available',
                action: Wrap(
                  spacing: 8,
                  children: <Widget>[
                    TextButton(
                      onPressed: controller.mutating
                          ? null
                          : () async {
                              await _showCreateWorkspaceDialog(context, controller);
                            },
                      child: const Text('New'),
                    ),
                    TextButton(
                      onPressed: () async {
                        await _showWorkspaceManagerSheet(context, controller);
                      },
                      child: const Text('Manage'),
                    ),
                  ],
                ),
              ),
              if (workspaces.isEmpty)
                const _InfoCard(
                  title: 'No workspaces yet',
                  body: 'Create a workspace first so a coding session has somewhere to run.',
                )
              else
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: workspaces.map((CodingWorkspace workspace) {
                    final String label = workspace.visible
                        ? workspace.name
                        : '${workspace.name} (hidden)';
                    return ChoiceChip(
                      label: Text(label),
                      selected: workspace.id == controller.selectedWorkspaceId,
                      onSelected: (_) {
                        controller.selectWorkspace(workspace.id);
                      },
                    );
                  }).toList(growable: false),
                ),
              const SizedBox(height: 16),
              _SectionTitle(
                title: 'Sessions',
                subtitle: controller.selectedWorkspaceId == null
                    ? 'All sessions'
                    : '${sessions.length} in selected workspace',
                action: TextButton(
                  onPressed: controller.mutating || controller.selectedWorkspaceId == null
                      ? null
                      : () async {
                          await _showCreateSessionDialog(
                            context,
                            controller,
                            canUseFullHost: canUseFullHost,
                          );
                        },
                  child: const Text('New Session'),
                ),
              ),
              if (sessions.isEmpty)
                const _InfoCard(
                  title: 'No coding sessions',
                  body: 'Create a session for the selected workspace first.',
                )
              else
                ...sessions.map((CodingSession session) {
                  return Card(
                    child: ListTile(
                      title: Text(session.title),
                      subtitle: Text(
                        [
                          session.status,
                          if (session.model != null) session.model!,
                          if (session.lastUpdate != null) session.lastUpdate!,
                          if (session.archivedAt != null) 'archived',
                        ].join(' · '),
                      ),
                      trailing: _SessionTrailing(session: session),
                      selected: session.id == controller.selectedSessionId,
                      onTap: () {
                        controller.selectSession(session.id);
                      },
                    ),
                  );
                }),
              const SizedBox(height: 16),
              _SectionTitle(
                title: 'Prompt',
                subtitle: selectedSession == null
                    ? 'Select a session first.'
                    : 'Send the next prompt to ${selectedSession.title}.',
                action: selectedSession == null
                    ? null
                    : Wrap(
                        spacing: 4,
                        children: <Widget>[
                          IconButton(
                            onPressed: controller.mutating
                                ? null
                                : () {
                                    controller.refresh();
                                  },
                            icon: const Icon(Icons.refresh),
                            tooltip: 'Refresh',
                          ),
                          IconButton(
                            onPressed: controller.mutating
                                ? null
                                : () async {
                                    await _showSessionSettingsSheet(
                                      context,
                                      controller,
                                      detail: detail ?? controller.detail,
                                      bootstrap: bootstrap,
                                      canUseFullHost: canUseFullHost,
                                    );
                                  },
                            icon: const Icon(Icons.tune),
                            tooltip: 'Session settings',
                          ),
                          if (selectedSession.activeTurnId != null)
                            IconButton(
                              onPressed: controller.mutating
                                  ? null
                                  : () {
                                      controller.stopSelectedSession();
                                    },
                              icon: const Icon(Icons.stop_circle_outlined),
                              tooltip: 'Stop turn',
                            ),
                          PopupMenuButton<_SessionAction>(
                            onSelected: (_SessionAction action) async {
                              await _handleSessionAction(
                                context,
                                controller,
                                selectedSession,
                                action,
                              );
                            },
                            itemBuilder: (BuildContext context) {
                              return <PopupMenuEntry<_SessionAction>>[
                                const PopupMenuItem<_SessionAction>(
                                  value: _SessionAction.restart,
                                  child: Text('Restart session'),
                                ),
                                const PopupMenuItem<_SessionAction>(
                                  value: _SessionAction.fork,
                                  child: Text('Fork session'),
                                ),
                                PopupMenuItem<_SessionAction>(
                                  value: selectedSession.archivedAt == null
                                      ? _SessionAction.archive
                                      : _SessionAction.restore,
                                  child: Text(
                                    selectedSession.archivedAt == null
                                        ? 'Archive session'
                                        : 'Restore session',
                                  ),
                                ),
                                const PopupMenuItem<_SessionAction>(
                                  value: _SessionAction.delete,
                                  child: Text('Delete session'),
                                ),
                              ];
                            },
                          ),
                        ],
                      ),
              ),
              if (selectedSession != null) ...<Widget>[
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: <Widget>[
                    OutlinedButton.icon(
                      onPressed: controller.mutating
                          ? null
                          : () async {
                              await _pickAndUploadAttachments(context, controller);
                            },
                      icon: const Icon(Icons.attach_file),
                      label: const Text('Add Files'),
                    ),
                    if (selectedSession.activeTurnId != null)
                      Chip(
                        label: Text('Active turn: ${selectedSession.activeTurnId}'),
                      ),
                    Chip(
                      label: Text('Mode: ${selectedSession.approvalMode}'),
                    ),
                    Chip(
                      label: Text('Security: ${selectedSession.securityProfile}'),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
              ],
              if (draftAttachments.isNotEmpty) ...<Widget>[
                _SectionTitle(
                  title: 'Draft Attachments',
                  subtitle: '${draftAttachments.length} waiting to send',
                ),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: draftAttachments.map((AttachmentSummary attachment) {
                    return InputChip(
                      label: Text(
                        '${attachment.filename} · ${_formatAttachmentSize(attachment.sizeBytes)}',
                      ),
                      onDeleted: controller.mutating
                          ? null
                          : () {
                              controller.removeDraftAttachment(attachment.id);
                            },
                    );
                  }).toList(growable: false),
                ),
                const SizedBox(height: 12),
              ],
              TextField(
                controller: _promptController,
                minLines: 3,
                maxLines: 8,
                enabled: controller.selectedSessionId != null && !controller.mutating,
                decoration: const InputDecoration(
                  hintText: 'Send the next coding prompt. You can also send attachments without text.',
                  border: OutlineInputBorder(),
                ),
                onChanged: (_) {
                  setState(() {});
                },
              ),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton(
                  onPressed: canSendPrompt
                      ? () async {
                          await controller.startTurn(
                            _promptController.text,
                            attachmentIds: draftAttachments
                                .map((AttachmentSummary attachment) => attachment.id)
                                .toList(growable: false),
                          );
                          if (mounted && controller.error == null) {
                            _promptController.clear();
                            setState(() {});
                          }
                        }
                      : null,
                  child: Text(controller.mutating ? 'Working...' : 'Send'),
                ),
              ),
              const SizedBox(height: 16),
              if (detail != null) ...<Widget>[
                _SectionTitle(
                  title: 'Active Session',
                  subtitle: detail.transcriptTotal == 0
                      ? 'No transcript yet.'
                      : '${detail.transcriptTotal} transcript items',
                ),
                _InfoCard(
                  title: detail.session.title,
                  body: [
                    'Workspace: ${detail.session.workspace}',
                    'Owner: ${detail.session.ownerUsername}',
                    'Status: ${detail.session.status}',
                    'Approval mode: ${detail.session.approvalMode}',
                    'Security: ${detail.session.securityProfile}',
                    'Network enabled: ${detail.session.networkEnabled ? 'yes' : 'no'}',
                    if (detail.session.model != null) 'Model: ${detail.session.model}',
                    if (detail.session.reasoningEffort != null)
                      'Reasoning effort: ${detail.session.reasoningEffort}',
                    'Thread: ${detail.session.threadId}',
                    'Created: ${_formatIsoTimestamp(detail.session.createdAt)}',
                    'Updated: ${_formatIsoTimestamp(detail.session.updatedAt)}',
                    if (detail.session.lastIssue != null) 'Last issue: ${detail.session.lastIssue}',
                  ].join('\n'),
                ),
                if (detail.thread != null) ...<Widget>[
                  const SizedBox(height: 12),
                  _InfoCard(
                    title: 'Thread',
                    body: [
                      'Preview: ${detail.thread!.preview}',
                      'CWD: ${detail.thread!.cwd}',
                      'Status: ${detail.thread!.statusType}',
                      if (detail.thread!.activeFlags.isNotEmpty)
                        'Flags: ${detail.thread!.activeFlags.join(', ')}',
                      if (detail.thread!.path != null) 'Path: ${detail.thread!.path}',
                      if (detail.thread!.cliVersion != null)
                        'CLI version: ${detail.thread!.cliVersion}',
                      if (detail.thread!.modelProvider != null)
                        'Model provider: ${detail.thread!.modelProvider}',
                      'Updated: ${_formatEpochTimestamp(detail.thread!.updatedAt)}',
                    ].join('\n'),
                  ),
                ],
              ],
              if (detail != null && detail.approvals.isNotEmpty) ...<Widget>[
                const SizedBox(height: 16),
                _SectionTitle(
                  title: 'Approvals',
                  subtitle: '${detail.approvals.length} pending',
                ),
                ...detail.approvals.map((PendingApproval approval) {
                  final bool canApproveSession = approval.scopeOptions.contains('session');
                  return Card(
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(
                            approval.title,
                            style: theme.textTheme.titleMedium,
                          ),
                          const SizedBox(height: 8),
                          Text(approval.risk),
                          const SizedBox(height: 6),
                          Text(
                            'Method: ${approval.method}',
                            style: theme.textTheme.bodySmall,
                          ),
                          const SizedBox(height: 12),
                          Wrap(
                            spacing: 12,
                            runSpacing: 12,
                            children: <Widget>[
                              FilledButton.tonal(
                                onPressed: controller.mutating
                                    ? null
                                    : () {
                                        controller.resolveApproval(
                                          approval.id,
                                          decision: 'decline',
                                        );
                                      },
                                child: const Text('Decline'),
                              ),
                              FilledButton(
                                onPressed: controller.mutating
                                    ? null
                                    : () {
                                        controller.resolveApproval(
                                          approval.id,
                                          decision: 'accept',
                                        );
                                      },
                                child: const Text('Approve Once'),
                              ),
                              if (canApproveSession)
                                OutlinedButton(
                                  onPressed: controller.mutating
                                      ? null
                                      : () {
                                          controller.resolveApproval(
                                            approval.id,
                                            decision: 'accept',
                                            scope: 'session',
                                          );
                                        },
                                  child: const Text('Approve Session'),
                                ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  );
                }),
              ],
              if (detail != null) ...<Widget>[
                const SizedBox(height: 16),
                _SectionTitle(
                  title: 'Transcript',
                  action: controller.canLoadOlderTranscript
                      ? TextButton(
                          onPressed: controller.loadingOlderTranscript
                              ? null
                              : () {
                                  controller.loadOlderTranscript();
                                },
                          child: Text(
                            controller.loadingOlderTranscript
                                ? 'Loading...'
                                : 'Load Older',
                          ),
                        )
                      : null,
                ),
                if (controller.loadingDetail && transcript == null)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 24),
                    child: Center(child: CircularProgressIndicator()),
                  )
                else if (transcript == null || transcript.items.isEmpty)
                  const _InfoCard(
                    title: 'No transcript yet',
                    body: 'The session has not produced visible transcript items yet.',
                  )
                else
                  ...transcript.items.map((TranscriptEntry item) {
                    return Card(
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Row(
                              children: <Widget>[
                                _TranscriptKindBadge(kind: item.kind),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text(
                                    item.title ?? item.label ?? item.kind,
                                    style: theme.textTheme.titleSmall,
                                  ),
                                ),
                              ],
                            ),
                            if (item.meta != null) ...<Widget>[
                              const SizedBox(height: 6),
                              Text(
                                item.meta!,
                                style: theme.textTheme.bodySmall,
                              ),
                            ],
                            const SizedBox(height: 10),
                            SelectableText(
                              item.body.isEmpty ? '(empty)' : item.body,
                            ),
                            if (item.fileChanges.isNotEmpty) ...<Widget>[
                              const SizedBox(height: 12),
                              ...item.fileChanges.map((SessionFileChange change) {
                                return _DiffCard(
                                  title: change.path,
                                  subtitle: change.kind,
                                  diff: change.diff,
                                );
                              }),
                            ],
                            if (item.attachments.isNotEmpty) ...<Widget>[
                              const SizedBox(height: 10),
                              Wrap(
                                spacing: 8,
                                runSpacing: 8,
                                children: item.attachments.map((AttachmentSummary attachment) {
                                  return Chip(
                                    label: Text(
                                      '${attachment.filename} · ${_formatAttachmentSize(attachment.sizeBytes)}',
                                    ),
                                  );
                                }).toList(growable: false),
                              ),
                            ],
                          ],
                        ),
                      ),
                    );
                  }),
              ],
              if (detail != null && detail.commands.isNotEmpty) ...<Widget>[
                const SizedBox(height: 16),
                _SectionTitle(
                  title: 'Commands',
                  subtitle: '${detail.commands.length} recent',
                ),
                ...detail.commands.map((SessionCommandEvent event) {
                  return Card(
                    child: ExpansionTile(
                      title: Text(event.command),
                      subtitle: Text(
                        '${event.status} · ${event.cwd}${event.exitCode == null ? '' : ' · exit ${event.exitCode}'}',
                      ),
                      children: <Widget>[
                        Padding(
                          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                          child: SelectableText(
                            event.output.isEmpty ? '(no output)' : event.output,
                          ),
                        ),
                      ],
                    ),
                  );
                }),
              ],
              if (detail != null && detail.changes.isNotEmpty) ...<Widget>[
                const SizedBox(height: 16),
                _SectionTitle(
                  title: 'Changes',
                  subtitle: '${detail.changes.length} recent',
                ),
                ...detail.changes.map((SessionFileChangeEvent change) {
                  return _DiffCard(
                    title: change.path,
                    subtitle: '${change.kind} · ${change.status}',
                    diff: change.diff,
                  );
                }),
              ],
              if (detail != null && detail.liveEvents.isNotEmpty) ...<Widget>[
                const SizedBox(height: 16),
                _SectionTitle(
                  title: 'Live Events',
                  subtitle: '${detail.liveEvents.length} recent',
                ),
                ...detail.liveEvents.map((SessionEvent event) {
                  return Card(
                    child: ListTile(
                      title: Text(event.summary),
                      subtitle: Text('${event.method} · ${_formatIsoTimestamp(event.createdAt)}'),
                    ),
                  );
                }),
              ],
              if (controller.error != null) ...<Widget>[
                const SizedBox(height: 16),
                Text(
                  controller.error!,
                  style: TextStyle(
                    color: theme.colorScheme.error,
                  ),
                ),
              ],
            ],
          ),
        );
      },
    );
  }

  Future<void> _pickAndUploadAttachments(
    BuildContext context,
    CodingController controller,
  ) async {
    final AppScope scope = AppScope.of(context);
    final attachments = await scope.attachmentPicker.pickAttachments();
    if (attachments.isEmpty) {
      return;
    }
    await controller.uploadAttachments(attachments);
  }

  Future<void> _handleSessionAction(
    BuildContext context,
    CodingController controller,
    CodingSession session,
    _SessionAction action,
  ) async {
    switch (action) {
      case _SessionAction.restart:
        await controller.restartSelectedSession();
        break;
      case _SessionAction.fork:
        await controller.forkSelectedSession();
        break;
      case _SessionAction.archive:
        await controller.archiveSelectedSession();
        break;
      case _SessionAction.restore:
        await controller.restoreSelectedSession();
        break;
      case _SessionAction.delete:
        final bool shouldDelete = await _confirmDeleteSession(context, session.title);
        if (shouldDelete) {
          await controller.deleteSelectedSession();
        }
        break;
    }
  }

  Future<bool> _confirmDeleteSession(
    BuildContext context,
    String sessionTitle,
  ) async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext context) {
        return AlertDialog(
          title: const Text('Delete session?'),
          content: Text('Delete "$sessionTitle"? This cannot be undone.'),
          actions: <Widget>[
            TextButton(
              onPressed: () {
                Navigator.of(context).pop(false);
              },
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () {
                Navigator.of(context).pop(true);
              },
              child: const Text('Delete'),
            ),
          ],
        );
      },
    );
    return confirmed ?? false;
  }

  Future<void> _showCreateSessionDialog(
    BuildContext context,
    CodingController controller, {
    required bool canUseFullHost,
  }) async {
    final CodingBootstrap? bootstrap = controller.bootstrap;
    if (bootstrap == null) {
      return;
    }

    final TextEditingController titleController = TextEditingController();
    String model = bootstrap.defaultModel;
    String effort = controller.preferredReasoningEffortForModel(model);
    String securityProfile = 'repo-write';
    String approvalMode = 'detailed';

    try {
      final _CreateSessionDraft? draft = await showModalBottomSheet<_CreateSessionDraft>(
        context: context,
        isScrollControlled: true,
        builder: (BuildContext context) {
          return StatefulBuilder(
            builder: (BuildContext context, void Function(void Function()) setModalState) {
              final List<String> supportedEfforts = controller.supportedReasoningEffortsForModel(model);
              if (!supportedEfforts.contains(effort)) {
                effort = controller.preferredReasoningEffortForModel(model);
              }

              return _BottomSheetFrame(
                title: 'Create Session',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    TextField(
                      controller: titleController,
                      decoration: const InputDecoration(
                        labelText: 'Title',
                        hintText: 'Optional session title',
                      ),
                    ),
                    const SizedBox(height: 16),
                    DropdownButtonFormField<String>(
                      value: model,
                      decoration: const InputDecoration(
                        labelText: 'Model',
                      ),
                      items: bootstrap.availableModels.map((ApiModelOption option) {
                        return DropdownMenuItem<String>(
                          value: option.model,
                          child: Text(option.displayName),
                        );
                      }).toList(growable: false),
                      onChanged: (String? nextValue) {
                        if (nextValue == null) {
                          return;
                        }
                        setModalState(() {
                          model = nextValue;
                          effort = controller.preferredReasoningEffortForModel(nextValue);
                        });
                      },
                    ),
                    const SizedBox(height: 16),
                    DropdownButtonFormField<String>(
                      value: effort,
                      decoration: const InputDecoration(
                        labelText: 'Reasoning effort',
                      ),
                      items: supportedEfforts.map((String option) {
                        return DropdownMenuItem<String>(
                          value: option,
                          child: Text(option),
                        );
                      }).toList(growable: false),
                      onChanged: (String? nextValue) {
                        if (nextValue == null) {
                          return;
                        }
                        setModalState(() {
                          effort = nextValue;
                        });
                      },
                    ),
                    const SizedBox(height: 16),
                    DropdownButtonFormField<String>(
                      value: approvalMode,
                      decoration: const InputDecoration(
                        labelText: 'Approval mode',
                      ),
                      items: const <DropdownMenuItem<String>>[
                        DropdownMenuItem<String>(
                          value: 'detailed',
                          child: Text('detailed'),
                        ),
                        DropdownMenuItem<String>(
                          value: 'less-interruption',
                          child: Text('less-interruption'),
                        ),
                        DropdownMenuItem<String>(
                          value: 'full-auto',
                          child: Text('full-auto'),
                        ),
                      ],
                      onChanged: (String? nextValue) {
                        if (nextValue == null) {
                          return;
                        }
                        setModalState(() {
                          approvalMode = nextValue;
                        });
                      },
                    ),
                    const SizedBox(height: 16),
                    DropdownButtonFormField<String>(
                      value: securityProfile,
                      decoration: const InputDecoration(
                        labelText: 'Security profile',
                      ),
                      items: <DropdownMenuItem<String>>[
                        const DropdownMenuItem<String>(
                          value: 'repo-write',
                          child: Text('repo-write'),
                        ),
                        if (canUseFullHost || securityProfile == 'full-host')
                          const DropdownMenuItem<String>(
                            value: 'full-host',
                            child: Text('full-host'),
                          ),
                      ],
                      onChanged: (String? nextValue) {
                        if (nextValue == null) {
                          return;
                        }
                        setModalState(() {
                          securityProfile = nextValue;
                        });
                      },
                    ),
                    const SizedBox(height: 20),
                    Align(
                      alignment: Alignment.centerRight,
                      child: FilledButton(
                        onPressed: () {
                          Navigator.of(context).pop(
                            _CreateSessionDraft(
                              title: titleController.text.trim(),
                              model: model,
                              reasoningEffort: effort,
                              securityProfile: securityProfile,
                              approvalMode: approvalMode,
                            ),
                          );
                        },
                        child: const Text('Create'),
                      ),
                    ),
                  ],
                ),
              );
            },
          );
        },
      );

      if (draft == null) {
        return;
      }

      await controller.createSession(
        title: draft.title.isEmpty ? null : draft.title,
        model: draft.model,
        reasoningEffort: draft.reasoningEffort,
        securityProfile: draft.securityProfile,
        approvalMode: draft.approvalMode,
      );
    } finally {
      titleController.dispose();
    }
  }

  Future<void> _showSessionSettingsSheet(
    BuildContext context,
    CodingController controller, {
    required CodingSessionDetail? detail,
    required CodingBootstrap bootstrap,
    required bool canUseFullHost,
  }) async {
    if (detail == null) {
      return;
    }

    final CodingSession session = detail.session;
    final TextEditingController titleController = TextEditingController(
      text: session.title,
    );
    String workspaceId = session.workspaceId;
    String model = session.model ?? bootstrap.defaultModel;
    String effort = session.reasoningEffort ?? controller.preferredReasoningEffortForModel(model);
    String approvalMode = session.approvalMode;
    String securityProfile = session.securityProfile;
    final bool threadLocked = session.activeTurnId != null;

    try {
      final _SessionSettingsDraft? draft = await showModalBottomSheet<_SessionSettingsDraft>(
        context: context,
        isScrollControlled: true,
        builder: (BuildContext context) {
          return StatefulBuilder(
            builder: (BuildContext context, void Function(void Function()) setModalState) {
              final List<String> supportedEfforts = controller.supportedReasoningEffortsForModel(model);
              if (!supportedEfforts.contains(effort)) {
                effort = controller.preferredReasoningEffortForModel(model);
              }

              return _BottomSheetFrame(
                title: 'Session Settings',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    if (threadLocked)
                      Container(
                        width: double.infinity,
                        margin: const EdgeInsets.only(bottom: 16),
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: Theme.of(context).colorScheme.secondaryContainer,
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: const Text(
                          'Workspace and security profile are locked while a turn is active.',
                        ),
                      ),
                    TextField(
                      controller: titleController,
                      decoration: const InputDecoration(
                        labelText: 'Title',
                      ),
                    ),
                    const SizedBox(height: 16),
                    DropdownButtonFormField<String>(
                      value: workspaceId,
                      decoration: const InputDecoration(
                        labelText: 'Workspace',
                      ),
                      items: bootstrap.workspaces.map((CodingWorkspace workspace) {
                        final String label = workspace.visible
                            ? workspace.name
                            : '${workspace.name} (hidden)';
                        return DropdownMenuItem<String>(
                          value: workspace.id,
                          child: Text(label),
                        );
                      }).toList(growable: false),
                      onChanged: threadLocked
                          ? null
                          : (String? nextValue) {
                              if (nextValue == null) {
                                return;
                              }
                              setModalState(() {
                                workspaceId = nextValue;
                              });
                            },
                    ),
                    const SizedBox(height: 16),
                    DropdownButtonFormField<String>(
                      value: securityProfile,
                      decoration: const InputDecoration(
                        labelText: 'Security profile',
                      ),
                      items: <DropdownMenuItem<String>>[
                        const DropdownMenuItem<String>(
                          value: 'repo-write',
                          child: Text('repo-write'),
                        ),
                        if (canUseFullHost)
                          const DropdownMenuItem<String>(
                            value: 'full-host',
                            child: Text('full-host'),
                          ),
                      ],
                      onChanged: threadLocked
                          ? null
                          : (String? nextValue) {
                              if (nextValue == null) {
                                return;
                              }
                              setModalState(() {
                                securityProfile = nextValue;
                              });
                            },
                    ),
                    const SizedBox(height: 16),
                    DropdownButtonFormField<String>(
                      value: model,
                      decoration: const InputDecoration(
                        labelText: 'Model',
                      ),
                      items: bootstrap.availableModels.map((ApiModelOption option) {
                        return DropdownMenuItem<String>(
                          value: option.model,
                          child: Text(option.displayName),
                        );
                      }).toList(growable: false),
                      onChanged: (String? nextValue) {
                        if (nextValue == null) {
                          return;
                        }
                        setModalState(() {
                          model = nextValue;
                          effort = controller.preferredReasoningEffortForModel(nextValue);
                        });
                      },
                    ),
                    const SizedBox(height: 16),
                    DropdownButtonFormField<String>(
                      value: effort,
                      decoration: const InputDecoration(
                        labelText: 'Reasoning effort',
                      ),
                      items: supportedEfforts.map((String option) {
                        return DropdownMenuItem<String>(
                          value: option,
                          child: Text(option),
                        );
                      }).toList(growable: false),
                      onChanged: (String? nextValue) {
                        if (nextValue == null) {
                          return;
                        }
                        setModalState(() {
                          effort = nextValue;
                        });
                      },
                    ),
                    const SizedBox(height: 16),
                    DropdownButtonFormField<String>(
                      value: approvalMode,
                      decoration: const InputDecoration(
                        labelText: 'Approval mode',
                      ),
                      items: const <DropdownMenuItem<String>>[
                        DropdownMenuItem<String>(
                          value: 'detailed',
                          child: Text('detailed'),
                        ),
                        DropdownMenuItem<String>(
                          value: 'less-interruption',
                          child: Text('less-interruption'),
                        ),
                        DropdownMenuItem<String>(
                          value: 'full-auto',
                          child: Text('full-auto'),
                        ),
                      ],
                      onChanged: (String? nextValue) {
                        if (nextValue == null) {
                          return;
                        }
                        setModalState(() {
                          approvalMode = nextValue;
                        });
                      },
                    ),
                    const SizedBox(height: 20),
                    Align(
                      alignment: Alignment.centerRight,
                      child: FilledButton(
                        onPressed: titleController.text.trim().isEmpty
                            ? null
                            : () {
                                Navigator.of(context).pop(
                                  _SessionSettingsDraft(
                                    title: titleController.text.trim(),
                                    workspaceId: workspaceId,
                                    securityProfile: securityProfile,
                                    approvalMode: approvalMode,
                                    model: model,
                                    reasoningEffort: effort,
                                  ),
                                );
                              },
                        child: const Text('Save'),
                      ),
                    ),
                  ],
                ),
              );
            },
          );
        },
      );

      if (draft == null) {
        return;
      }

      await controller.saveSelectedSessionSettings(
        title: draft.title,
        workspaceId: draft.workspaceId,
        securityProfile: draft.securityProfile,
        approvalMode: draft.approvalMode,
        model: draft.model,
        reasoningEffort: draft.reasoningEffort,
      );
    } finally {
      titleController.dispose();
    }
  }

  Future<void> _showCreateWorkspaceDialog(
    BuildContext context,
    CodingController controller,
  ) async {
    final TextEditingController nameController = TextEditingController();
    final TextEditingController gitUrlController = TextEditingController();
    String source = 'empty';

    try {
      final _CreateWorkspaceDraft? draft = await showModalBottomSheet<_CreateWorkspaceDraft>(
        context: context,
        isScrollControlled: true,
        builder: (BuildContext context) {
          return StatefulBuilder(
            builder: (BuildContext context, void Function(void Function()) setModalState) {
              final bool canSubmit = source == 'empty'
                  ? nameController.text.trim().isNotEmpty
                  : gitUrlController.text.trim().isNotEmpty;

              return _BottomSheetFrame(
                title: 'Create Workspace',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Wrap(
                      spacing: 8,
                      children: <Widget>[
                        ChoiceChip(
                          label: const Text('Empty'),
                          selected: source == 'empty',
                          onSelected: (_) {
                            setModalState(() {
                              source = 'empty';
                            });
                          },
                        ),
                        ChoiceChip(
                          label: const Text('Git'),
                          selected: source == 'git',
                          onSelected: (_) {
                            setModalState(() {
                              source = 'git';
                            });
                          },
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    if (source == 'empty')
                      TextField(
                        controller: nameController,
                        decoration: const InputDecoration(
                          labelText: 'Workspace name',
                          hintText: 'my-repo',
                        ),
                        onChanged: (_) {
                          setModalState(() {});
                        },
                      )
                    else
                      TextField(
                        controller: gitUrlController,
                        keyboardType: TextInputType.url,
                        decoration: const InputDecoration(
                          labelText: 'Git URL',
                          hintText: 'https://github.com/org/repo.git',
                        ),
                        onChanged: (_) {
                          setModalState(() {});
                        },
                      ),
                    const SizedBox(height: 20),
                    Align(
                      alignment: Alignment.centerRight,
                      child: FilledButton(
                        onPressed: !canSubmit
                            ? null
                            : () {
                                Navigator.of(context).pop(
                                  _CreateWorkspaceDraft(
                                    source: source,
                                    name: nameController.text.trim(),
                                    gitUrl: gitUrlController.text.trim(),
                                  ),
                                );
                              },
                        child: const Text('Create'),
                      ),
                    ),
                  ],
                ),
              );
            },
          );
        },
      );

      if (draft == null) {
        return;
      }

      await controller.createWorkspace(
        source: draft.source,
        name: draft.name.isEmpty ? null : draft.name,
        gitUrl: draft.gitUrl.isEmpty ? null : draft.gitUrl,
      );
    } finally {
      nameController.dispose();
      gitUrlController.dispose();
    }
  }

  Future<void> _showWorkspaceManagerSheet(
    BuildContext context,
    CodingController controller,
  ) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (BuildContext context) {
        return AnimatedBuilder(
          animation: controller,
          builder: (BuildContext context, Widget? child) {
            final CodingBootstrap? bootstrap = controller.bootstrap;
            final List<CodingWorkspace> workspaces = bootstrap == null
                ? const <CodingWorkspace>[]
                : <CodingWorkspace>[...bootstrap.workspaces]
                  ..sort((CodingWorkspace left, CodingWorkspace right) {
                    return left.sortOrder.compareTo(right.sortOrder);
                  });

            return _BottomSheetFrame(
              title: 'Manage Workspaces',
              child: SizedBox(
                height: 360,
                child: workspaces.isEmpty
                    ? const Center(
                        child: Text('No workspaces yet.'),
                      )
                    : ListView.builder(
                        itemCount: workspaces.length,
                        itemBuilder: (BuildContext context, int index) {
                          final CodingWorkspace workspace = workspaces[index];
                          return Card(
                            child: ListTile(
                              title: Text(workspace.name),
                              subtitle: Text(
                                '${workspace.path}\n${workspace.visible ? 'visible' : 'hidden'}',
                              ),
                              isThreeLine: true,
                              leading: Icon(
                                workspace.visible
                                    ? Icons.folder_outlined
                                    : Icons.folder_off_outlined,
                              ),
                              trailing: SizedBox(
                                width: 176,
                                child: Row(
                                  mainAxisAlignment: MainAxisAlignment.end,
                                  children: <Widget>[
                                    IconButton(
                                      onPressed: index == 0 || controller.mutating
                                          ? null
                                          : () {
                                              controller.moveWorkspace(
                                                workspace.id,
                                                direction: -1,
                                              );
                                            },
                                      icon: const Icon(Icons.arrow_upward),
                                      tooltip: 'Move up',
                                    ),
                                    IconButton(
                                      onPressed: index == workspaces.length - 1 || controller.mutating
                                          ? null
                                          : () {
                                              controller.moveWorkspace(
                                                workspace.id,
                                                direction: 1,
                                              );
                                            },
                                      icon: const Icon(Icons.arrow_downward),
                                      tooltip: 'Move down',
                                    ),
                                    Switch(
                                      value: workspace.visible,
                                      onChanged: controller.mutating
                                          ? null
                                          : (bool nextValue) {
                                              controller.setWorkspaceVisibility(
                                                workspace.id,
                                                visible: nextValue,
                                              );
                                            },
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          );
                        },
                      ),
              ),
            );
          },
        );
      },
    );
  }
}

class _BottomSheetFrame extends StatelessWidget {
  const _BottomSheetFrame({
    required this.title,
    required this.child,
  });

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final EdgeInsets viewInsets = MediaQuery.of(context).viewInsets;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + viewInsets.bottom),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                title,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 16),
              child,
            ],
          ),
        ),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle({
    required this.title,
    this.subtitle,
    this.action,
  });

  final String title;
  final String? subtitle;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  title,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                if (subtitle != null) ...<Widget>[
                  const SizedBox(height: 2),
                  Text(
                    subtitle!,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ],
            ),
          ),
          if (action != null) action!,
        ],
      ),
    );
  }
}

class _InfoCard extends StatelessWidget {
  const _InfoCard({
    required this.title,
    required this.body,
  });

  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              title,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            SelectableText(body),
          ],
        ),
      ),
    );
  }
}

class _DiffCard extends StatelessWidget {
  const _DiffCard({
    required this.title,
    required this.subtitle,
    required this.diff,
  });

  final String title;
  final String subtitle;
  final String? diff;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: ExpansionTile(
        title: Text(title),
        subtitle: Text(subtitle),
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: SelectableText(diff?.isNotEmpty == true ? diff! : '(no diff)'),
          ),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({
    required this.message,
  });

  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          message,
          textAlign: TextAlign.center,
        ),
      ),
    );
  }
}

class _SessionTrailing extends StatelessWidget {
  const _SessionTrailing({
    required this.session,
  });

  final CodingSession session;

  @override
  Widget build(BuildContext context) {
    final List<Widget> indicators = <Widget>[];

    if (session.archivedAt != null) {
      indicators.add(
        const Icon(Icons.archive_outlined, size: 18),
      );
    }
    if (session.needsApproval) {
      indicators.add(
        const Icon(Icons.warning_amber_rounded, size: 18),
      );
    } else if (session.activeTurnId != null || session.status == 'running') {
      indicators.add(
        const SizedBox(
          width: 18,
          height: 18,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }

    if (indicators.isEmpty) {
      return const Icon(Icons.chevron_right);
    }

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: indicators
          .map((Widget item) => Padding(
                padding: const EdgeInsets.only(left: 8),
                child: item,
              ))
          .toList(growable: false),
    );
  }
}

class _TranscriptKindBadge extends StatelessWidget {
  const _TranscriptKindBadge({
    required this.kind,
  });

  final String kind;

  @override
  Widget build(BuildContext context) {
    final ColorScheme colorScheme = Theme.of(context).colorScheme;
    final Color background;
    switch (kind) {
      case 'assistant':
        background = colorScheme.primaryContainer;
        break;
      case 'user':
        background = colorScheme.secondaryContainer;
        break;
      case 'tool':
        background = colorScheme.tertiaryContainer;
        break;
      case 'status':
        background = colorScheme.surfaceContainerHighest;
        break;
      default:
        background = colorScheme.surfaceContainerHighest;
        break;
    }

    return DecoratedBox(
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        child: Text(kind),
      ),
    );
  }
}

class _CreateSessionDraft {
  const _CreateSessionDraft({
    required this.title,
    required this.model,
    required this.reasoningEffort,
    required this.securityProfile,
    required this.approvalMode,
  });

  final String title;
  final String model;
  final String reasoningEffort;
  final String securityProfile;
  final String approvalMode;
}

class _SessionSettingsDraft {
  const _SessionSettingsDraft({
    required this.title,
    required this.workspaceId,
    required this.securityProfile,
    required this.approvalMode,
    required this.model,
    required this.reasoningEffort,
  });

  final String title;
  final String workspaceId;
  final String securityProfile;
  final String approvalMode;
  final String model;
  final String reasoningEffort;
}

class _CreateWorkspaceDraft {
  const _CreateWorkspaceDraft({
    required this.source,
    required this.name,
    required this.gitUrl,
  });

  final String source;
  final String name;
  final String gitUrl;
}

String _formatAttachmentSize(int bytes) {
  if (bytes < 1024) {
    return '$bytes B';
  }
  if (bytes < 1024 * 1024) {
    return '${(bytes / 1024).toStringAsFixed(1)} KB';
  }
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}

String _formatIsoTimestamp(String value) {
  final DateTime? parsed = DateTime.tryParse(value);
  if (parsed == null) {
    return value;
  }
  return parsed.toLocal().toIso8601String();
}

String _formatEpochTimestamp(int value) {
  if (value <= 0) {
    return 'unknown';
  }
  return DateTime.fromMillisecondsSinceEpoch(value).toLocal().toIso8601String();
}

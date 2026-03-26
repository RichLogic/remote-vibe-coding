import 'package:flutter/material.dart';

import '../core/files/attachment_picker.dart';
import '../core/files/file_picker_attachment_picker.dart';
import '../core/http/api_client.dart';
import '../core/session/session_controller.dart';
import '../core/session/session_store.dart';
import '../core/session/user_session.dart';
import '../features/auth/presentation/token_login_page.dart';
import '../features/coding/application/coding_controller.dart';
import '../features/coding/data/coding_repository_impl.dart';
import '../features/home/presentation/home_shell.dart';
import 'app_scope.dart';

class RemoteVibeCodingApp extends StatefulWidget {
  const RemoteVibeCodingApp({
    required this.sessionStore,
    super.key,
  });

  final SessionStore sessionStore;

  @override
  State<RemoteVibeCodingApp> createState() => _RemoteVibeCodingAppState();
}

class _RemoteVibeCodingAppState extends State<RemoteVibeCodingApp> {
  late final SessionController _sessionController;

  @override
  void initState() {
    super.initState();
    _sessionController = SessionController(widget.sessionStore);
    _sessionController.restore();
  }

  @override
  void dispose() {
    _sessionController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'remote-vibe-coding',
      theme: ThemeData(
        colorSchemeSeed: const Color(0xFF0B57D0),
        useMaterial3: true,
      ),
      home: AnimatedBuilder(
        animation: _sessionController,
        builder: (BuildContext context, Widget? child) {
          if (_sessionController.restoring) {
            return const Scaffold(
              body: Center(
                child: CircularProgressIndicator(),
              ),
            );
          }

          if (!_sessionController.isAuthenticated) {
            return TokenLoginPage(
              sessionController: _sessionController,
            );
          }

          return _AuthenticatedApp(
            sessionController: _sessionController,
          );
        },
      ),
    );
  }
}

class _AuthenticatedApp extends StatefulWidget {
  const _AuthenticatedApp({
    required this.sessionController,
  });

  final SessionController sessionController;

  @override
  State<_AuthenticatedApp> createState() => _AuthenticatedAppState();
}

class _AuthenticatedAppState extends State<_AuthenticatedApp> {
  final AttachmentPicker _attachmentPicker = const FilePickerAttachmentPicker();
  CodingController? _codingController;
  StoredSession? _lastSession;

  @override
  void initState() {
    super.initState();
    _rebuildControllers();
  }

  @override
  void didUpdateWidget(covariant _AuthenticatedApp oldWidget) {
    super.didUpdateWidget(oldWidget);
    final StoredSession? nextSession = widget.sessionController.session;
    if (_hasSessionChanged(_lastSession, nextSession)) {
      _disposeControllers();
      _rebuildControllers();
    }
  }

  @override
  void dispose() {
    _disposeControllers();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final CodingController? codingController = _codingController;
    if (codingController == null) {
      return const Scaffold(
        body: Center(
          child: CircularProgressIndicator(),
        ),
      );
    }

    return AppScope(
      attachmentPicker: _attachmentPicker,
      sessionController: widget.sessionController,
      codingController: codingController,
      child: const HomeShell(),
    );
  }

  bool _hasSessionChanged(
    StoredSession? previous,
    StoredSession? next,
  ) {
    if (previous == null || next == null) {
      return previous != next;
    }
    return previous.hostUrl != next.hostUrl || previous.token != next.token;
  }

  void _disposeControllers() {
    _codingController?.dispose();
    _codingController = null;
  }

  void _rebuildControllers() {
    final StoredSession? session = widget.sessionController.session;
    if (session == null) {
      return;
    }

    _lastSession = session;
    final ApiClient apiClient = ApiClient(session);
    final CodingController codingController = CodingController(
      ApiCodingRepository(apiClient),
    );

    _codingController = codingController;

    codingController.loadBootstrap();
  }
}

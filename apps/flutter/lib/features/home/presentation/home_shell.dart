import 'package:flutter/material.dart';

import '../../../app/app_scope.dart';
import '../../coding/presentation/coding_screen.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  bool _startedPolling = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_startedPolling) {
      return;
    }
    final AppScope scope = AppScope.of(context);
    scope.codingController.startPolling();
    _startedPolling = true;
  }

  @override
  Widget build(BuildContext context) {
    final AppScope scope = AppScope.of(context);
    final String username = scope.sessionController.user?.username ?? 'mobile';

    return Scaffold(
      appBar: AppBar(
        title: const Text('Coding'),
        actions: <Widget>[
          Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Text(username),
            ),
          ),
          IconButton(
            onPressed: () {
              scope.sessionController.signOut();
            },
            icon: const Icon(Icons.logout),
            tooltip: 'Sign out',
          ),
        ],
      ),
      body: const CodingScreen(),
    );
  }
}

import 'package:flutter/material.dart';

import '../../../core/session/session_controller.dart';

class TokenLoginPage extends StatefulWidget {
  const TokenLoginPage({
    required this.sessionController,
    super.key,
  });

  final SessionController sessionController;

  @override
  State<TokenLoginPage> createState() => _TokenLoginPageState();
}

class _TokenLoginPageState extends State<TokenLoginPage> {
  late final TextEditingController _hostController;
  late final TextEditingController _tokenController;

  @override
  void initState() {
    super.initState();
    _hostController = TextEditingController(text: 'http://127.0.0.1:8787');
    _tokenController = TextEditingController();
  }

  @override
  void dispose() {
    _hostController.dispose();
    _tokenController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: AnimatedBuilder(
                animation: widget.sessionController,
                builder: (BuildContext context, Widget? child) {
                  final String? error = widget.sessionController.error;
                  final bool busy = widget.sessionController.busy;

                  return Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
                      Text(
                        'remote-vibe-coding',
                        style: Theme.of(context).textTheme.headlineMedium,
                      ),
                      const SizedBox(height: 12),
                      Text(
                        'Coding-only Flutter shell. Use your host URL and existing personal token.',
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                      const SizedBox(height: 24),
                      TextField(
                        controller: _hostController,
                        keyboardType: TextInputType.url,
                        decoration: const InputDecoration(
                          labelText: 'Host URL',
                          hintText: 'http://127.0.0.1:8787',
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 16),
                      TextField(
                        controller: _tokenController,
                        decoration: const InputDecoration(
                          labelText: 'Personal token',
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 16),
                      FilledButton(
                        onPressed: busy
                            ? null
                            : () {
                                widget.sessionController.signInWithToken(
                                  hostUrl: _hostController.text,
                                  token: _tokenController.text,
                                );
                              },
                        child: Text(busy ? 'Connecting...' : 'Connect'),
                      ),
                      const SizedBox(height: 12),
                      Text(
                        'Today the mobile client uses manual token auth because the backend login flow is still browser-first.',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      if (error != null) ...<Widget>[
                        const SizedBox(height: 16),
                        Text(
                          error,
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.error,
                          ),
                        ),
                      ],
                    ],
                  );
                },
              ),
            ),
          ),
        ),
      ),
    );
  }
}

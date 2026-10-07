import path from 'node:path';
import {
  agent,
  RequestError,
  type AgentConnection,
  type SessionUpdate,
  type Stream,
} from '@agentclientprotocol/sdk';
import { AgentHostClient, type SpawnedHostOptions } from './index.ts';
import type { AgentEvent, Approval, Message, ToolCall } from '../protocol/index.ts';

/** One connection and one deployment-selected workspace; ACP UI extensions are not implied. */
export function connectAcp(
  stream: Stream,
  options: SpawnedHostOptions,
): { connection: AgentConnection; close(): Promise<void> } {
  const host = new AgentHostClient(options);
  let initialized = false;
  const sessions = new Set<string>();
  const running = new Set<string>();
  const loading = new Set<string>();
  const cancelled = new Set<string>();
  let updates = Promise.resolve();
  let connection: AgentConnection;
  const permissions = new Map<string, { sessionId: string; controller: AbortController }>();
  const checkReady = () => {
    if (!initialized) throw RequestError.invalidRequest(undefined, 'initialize is required');
  };
  const checkSession = (sessionId: string) => {
    checkReady();
    if (!sessions.has(sessionId))
      throw RequestError.invalidParams(undefined, 'Unknown session; create or load it first');
  };
  const checkWorkspace = (params: {
    cwd: string;
    mcpServers: unknown[];
    additionalDirectories?: string[];
  }) => {
    checkReady();
    if (
      !path.isAbsolute(params.cwd) ||
      path.resolve(params.cwd) !== path.resolve(options.workspace)
    )
      throw RequestError.invalidParams(undefined, 'cwd must match the configured workspace');
    if (params.mcpServers.length || params.additionalDirectories?.length)
      throw RequestError.invalidParams(
        undefined,
        'Client MCP servers and additional workspace roots are not supported by this automation adapter',
      );
  };
  const notify = (sessionId: string, update: SessionUpdate) => {
    updates = updates.then(() => connection.client.notify('session/update', { sessionId, update }));
    void updates.catch((error: unknown) => connection.close(error));
    return updates;
  };
  const tool = (sessionId: string, call: ToolCall) =>
    notify(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: call.id,
      title: call.name,
      kind: 'other',
      status: 'pending',
      rawInput: call.arguments,
    });
  const finished = (sessionId: string, id: string, content: string, isError: boolean) =>
    notify(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: isError ? 'failed' : 'completed',
      content: [{ type: 'content', content: { type: 'text', text: content } }],
    });
  const replay = async (sessionId: string, message: Message) => {
    if (message.role === 'user' || message.role === 'assistant') {
      if (message.content)
        await notify(sessionId, {
          sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          content: {
            type: 'text',
            text:
              message.role === 'user'
                ? (message.displayContent ?? message.content)
                : message.content,
          },
        });
      if (message.role === 'assistant')
        for (const call of message.toolCalls) await tool(sessionId, call);
      if (message.role === 'user')
        for (const image of message.images ?? [])
          await notify(sessionId, {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'image', data: image.data, mimeType: image.mimeType },
          });
    } else {
      await finished(sessionId, message.toolCallId, message.content, message.isError);
    }
  };
  const respond = async (event: AgentEvent) => {
    const approval = event.data.approval as Approval;
    const approvalId = String(event.data.approvalId);
    const controller = new AbortController();
    permissions.set(approvalId, { sessionId: event.sessionId, controller });
    let allow = false;
    try {
      const reply = await connection.client.request(
        'session/request_permission',
        {
          sessionId: event.sessionId,
          toolCall: {
            toolCallId: approval.toolCall.id,
            title: approval.description ?? approval.toolCall.name,
            status: 'pending',
            kind: 'other',
            rawInput: approval.toolCall.arguments,
          },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
        { cancellationSignal: controller.signal },
      );
      allow =
        !controller.signal.aborted &&
        !cancelled.has(event.sessionId) &&
        reply.outcome.outcome === 'selected' &&
        reply.outcome.optionId === 'allow-once';
    } catch {
      /* Unavailable/invalid permission responses deny the write. */
    } finally {
      permissions.delete(approvalId);
    }
    if (host.status === 'ready')
      await host.request('approval.respond', { approvalId, allow }).catch(() => {});
  };
  const unsubscribe = host.subscribe((event) => {
    if (!sessions.has(event.sessionId) || loading.has(event.sessionId)) return;
    switch (event.type) {
      case 'message.delta':
        void notify(event.sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: String(event.data.text ?? '') },
        });
        break;
      case 'tool.started':
        void tool(event.sessionId, event.data.call as ToolCall);
        break;
      case 'tool.finished':
        void finished(
          event.sessionId,
          String(event.data.callId),
          String(event.data.content ?? ''),
          event.data.isError === true,
        );
        break;
      case 'approval.required':
        void respond(event);
        break;
      case 'question.required':
        // The ACP v1 text automation profile has no Host question UI mapping.
        void host
          .request('question.respond', {
            questionId: String(event.data.questionId),
            answers: [],
            cancelled: true,
          })
          .catch(() => {});
        break;
    }
  });
  const app = agent({ name: 'yuantu' })
    .onRequest('initialize', ({ params }) => {
      if (initialized) throw RequestError.invalidRequest(undefined, 'Already initialized');
      if (params.protocolVersion !== 1)
        throw RequestError.invalidParams(undefined, 'Only ACP v1 is supported');
      initialized = true;
      return {
        protocolVersion: 1,
        agentInfo: { name: 'yuantu', version: '0.1.0' },
        authMethods: [],
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
        },
      };
    })
    .onRequest('session/new', async ({ params }) => {
      checkWorkspace(params);
      await host.start();
      const session = await host.request('session.create', {});
      sessions.add(session.id);
      return { sessionId: session.id };
    })
    .onRequest('session/load', async ({ params }) => {
      checkWorkspace(params);
      if (running.has(params.sessionId) || loading.has(params.sessionId))
        throw RequestError.invalidRequest(undefined, 'Session is busy');
      loading.add(params.sessionId);
      try {
        await host.start();
        let offset = 0;
        while (true) {
          const page = await host.request('session.get', {
            sessionId: params.sessionId,
            offset,
            view: 'display',
          });
          let messages = page.messages;
          let nextOffset = page.nextOffset;
          if (page.messageChunk) {
            let serialized = page.messageChunk.part;
            let chunkOffset = page.messageChunk.nextChunkOffset;
            while (chunkOffset !== undefined) {
              const part = await host.request('session.get', {
                sessionId: params.sessionId,
                offset: page.messageChunk.index,
                view: 'display',
                chunkOffset,
              });
              if (!part.messageChunk) throw new Error('Missing history chunk');
              serialized += part.messageChunk.part;
              chunkOffset = part.messageChunk.nextChunkOffset;
              nextOffset = part.nextOffset;
            }
            messages = [...messages, JSON.parse(serialized) as Message];
          }
          for (const message of messages) await replay(params.sessionId, message);
          if (nextOffset === undefined) break;
          if (nextOffset <= offset) throw new Error('Non-progressing history page');
          offset = nextOffset;
        }
        sessions.add(params.sessionId);
        return {};
      } finally {
        loading.delete(params.sessionId);
      }
    })
    .onRequest('session/prompt', async ({ params }) => {
      checkSession(params.sessionId);
      if (running.has(params.sessionId) || loading.has(params.sessionId))
        throw RequestError.invalidRequest(undefined, 'Session is busy');
      if (!params.prompt.length || params.prompt.some((item) => item.type !== 'text'))
        throw RequestError.invalidParams(undefined, 'Only text prompt content is supported');
      const prompt = params.prompt
        .map((item) => (item.type === 'text' ? item.text : ''))
        .join('\n');
      running.add(params.sessionId);
      cancelled.delete(params.sessionId);
      try {
        const result = await host.run(params.sessionId, prompt);
        await updates;
        if (result.status === 'cancelled') return { stopReason: 'cancelled' };
        if (result.status === 'limited') return { stopReason: 'max_turn_requests' };
        if (result.status !== 'completed')
          throw RequestError.internalError(undefined, result.error ?? 'Host run failed');
        return { stopReason: 'end_turn' };
      } finally {
        running.delete(params.sessionId);
        for (const value of permissions.values())
          if (value.sessionId === params.sessionId) value.controller.abort();
      }
    })
    .onNotification('session/cancel', async ({ params }) => {
      checkSession(params.sessionId);
      cancelled.add(params.sessionId);
      for (const value of permissions.values())
        if (value.sessionId === params.sessionId) value.controller.abort();
      await host.request('run.cancel', { sessionId: params.sessionId });
    });
  connection = app.connect(stream);
  return {
    connection,
    async close() {
      unsubscribe();
      connection.close();
      await host.stop();
    },
  };
}

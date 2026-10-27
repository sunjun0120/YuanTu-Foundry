/** Pending decisions retain the workspace and Host epoch that raised them, even while another chat is visible. */
import { Modal } from '@mantine/core';
import { useEffect, useReducer, useState, type ReactNode } from 'react';
import type { CarrierCommand, CarrierSnapshot } from '../../contract.ts';
import type { WorkspaceTarget } from '../../workspace-routing.ts';
import type { ProjectWorkspacesFile } from '../../project-workspaces-contract.ts';
import type {
  PendingApproval,
  PendingQuestion,
} from '../../../../packages/client/session-controller.ts';
import { t } from '../../i18n.ts';
import { useLocale } from '../i18n.ts';
import { ApprovalCard } from '../conversation/Approvals.tsx';
import { approvalEntries } from '../conversation/approval-model.ts';
import { Questions } from '../conversation/Questions.tsx';
import {
  createQuestionDrafts,
  questionAnswers,
  questionCards,
  questionDraft,
  setQuestionPage,
  setQuestionText,
  toggleQuestionCollapsed,
  toggleQuestionOption,
} from '../conversation/question-model.ts';

interface PendingGroup extends WorkspaceTarget {
  sessionId: string;
  title: string;
  approvals: PendingApproval[];
  questions: PendingQuestion[];
}
function groups(view: WorkspaceTarget & { state: CarrierSnapshot }): PendingGroup[] {
  const { state, ...target } = view;
  const runs = [
    {
      sessionId: state.session.sessionId,
      approvals: state.session.approvals,
      questions: state.session.questions,
    },
    ...(state.session.otherRuns ?? []),
  ];
  return runs.flatMap((run) =>
    run.sessionId && (run.approvals.length || run.questions.length)
      ? [
          {
            ...target,
            sessionId: run.sessionId,
            title: state.sessions.find((session) => session.id === run.sessionId)?.title ?? '',
            approvals: run.approvals,
            questions: run.questions,
          },
        ]
      : [],
  );
}
export function WorkspaceInteractions({
  registry,
}: {
  registry: ProjectWorkspacesFile | null;
}): ReactNode {
  const [pending, setPending] = useState<Record<string, PendingGroup[]>>({});
  const [opened, setOpened] = useState(false);
  useEffect(
    () =>
      window.yuantu?.subscribeWorkspaceStates?.((view) => {
        const next = groups(view);
        setPending((held) =>
          JSON.stringify(held[view.workspaceId]) === JSON.stringify(next)
            ? held
            : { ...held, [view.workspaceId]: next },
        );
      }),
    [],
  );
  const visible = Object.values(pending)
    .flat()
    .filter((group) =>
      registry?.workspaces.some((entry) => entry.id === group.workspaceId && !entry.removed),
    );
  const count = visible.reduce(
    (total, group) => total + group.approvals.length + group.questions.length,
    0,
  );
  return (
    <>
      {count ? (
        <button type="button" className="project-waiting-summary" onClick={() => setOpened(true)}>
          {t('projects.waitingSummary', { count })}
          <span aria-hidden="true">!</span>
        </button>
      ) : null}
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title={t('projects.pendingTitle')}
        size="lg"
        closeButtonProps={{ 'aria-label': t('permission.dialog.close') }}
      >
        <div className="workspace-interactions">
          {visible.length ? (
            visible.map((group) => (
              <section key={`${group.workspaceId}:${group.hostEpoch}:${group.sessionId}`}>
                <h3>
                  {
                    registry?.workspaces.find((entry) => entry.id === group.workspaceId)
                      ?.displayName
                  }{' '}
                  · {group.title || t('ui.untitledSession')}
                </h3>
                <PendingCards group={group} />
              </section>
            ))
          ) : (
            <p>{t('projects.noPending')}</p>
          )}
        </div>
      </Modal>
    </>
  );
}
function PendingCards({ group }: { group: PendingGroup }): ReactNode {
  const lang = useLocale();
  const [drafts] = useState(createQuestionDrafts);
  const [busy] = useState(() => new Set<string>());
  const [error, setError] = useState('');
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const send = async (command: CarrierCommand): Promise<void> => {
    const key = 'id' in command ? command.id : command.type;
    if (busy.has(key)) return;
    busy.add(key);
    setError('');
    redraw();
    try {
      const reply = await window.yuantu.workspaceInvoke?.(group, command);
      if (reply && !reply.ok) setError(reply.error);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      busy.delete(key);
      redraw();
    }
  };
  const find = (id: string) => group.questions.find((item) => item.id === id);
  return (
    <>
      {error ? <p role="alert">{error}</p> : null}
      {approvalEntries(group.approvals).map((entry) => (
        <ApprovalCard
          key={entry.id}
          entry={entry}
          busy={busy.has(entry.id)}
          onDecision={(id, allow, remember) => {
            void send({ type: 'approve', id, allow, remember });
          }}
        />
      ))}
      <Questions
        cards={questionCards(group.questions, { ...drafts, busy }, lang)}
        actions={{
          selectOption(id, questionId, value) {
            const question = find(id)?.request.questions.find((item) => item.id === questionId);
            if (question) toggleQuestionOption(drafts, id, question, value);
            redraw();
          },
          setFreeText(id, questionId, value) {
            setQuestionText(drafts, id, questionId, value);
          },
          setPage(id, page) {
            setQuestionPage(drafts, id, page, find(id)?.request.questions.length ?? 0);
            redraw();
          },
          toggleCollapsed(id) {
            toggleQuestionCollapsed(drafts, id);
            redraw();
          },
          submit(id) {
            const question = find(id);
            if (question)
              void send({
                type: 'questionAnswer',
                id,
                answers: questionAnswers(question.request, questionDraft(drafts, id)),
              });
          },
          cancel(id) {
            void send({ type: 'questionAnswer', id, cancelled: true });
          },
        }}
        markdownActions={{
          copy: (text) => send({ type: 'copyText', text }),
          open: (url) => send({ type: 'openLink', url }),
        }}
      />
    </>
  );
}

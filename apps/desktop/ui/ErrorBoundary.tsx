/**
 * A React error boundary in the window's own words, with a way back.
 *
 * The old renderer had no equivalent: a thrown error inside `render()` stopped the module and left the last painted
 * frame on screen. In React a throw unmounts the subtree, so the boundary is the only place that can both say what
 * happened and offer the retry that re-mounts it. The error object stays in state; `reset` clears it and re-renders
 * the children, which is enough for the common failure (a bad value that the next snapshot no longer carries).
 *
 * The message is dictionary text so an English interface does not show Chinese here; the technical message is shown
 * beside it, because a person reporting the failure needs the sentence the runtime produced.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../i18n.ts';
import { Button, Stack, Text } from './primitives.tsx';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Called once the boundary has cleared the failure, for a parent that wants to re-fetch. */
  onReset?(): void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] render failed', error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Stack gap="xs" role="alert" p="md" data-ui-error="">
        <Text fw={500}>{t('ui.renderFailed')}</Text>
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
          {error.message}
        </Text>
        <Button variant="light" size="xs" onClick={this.reset}>
          {t('ui.retry')}
        </Button>
      </Stack>
    );
  }
}

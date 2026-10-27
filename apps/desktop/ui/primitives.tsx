/**
 * The project's Mantine layer: one import site for the controls the interface uses.
 *
 * Re-exporting rather than wrapping every component is deliberate. A wrapper that only forwards props adds a second
 * place to look when a control behaves differently from Mantine's documentation, and the project defaults that do
 * matter (sizes, radius, theme) belong in the provider's `components` map, not in thirty nearly identical files.
 * The two things that genuinely need a project shape are here because they change the contract rather than the
 * defaults:
 *
 * - `Select` is the project's dropdown: Mantine's value shape and behaviour, plus the single-chevron indicator and the
 *   right-hand check every dropdown in the window shares. The old `<select>` convenience of `''` for "nothing chosen"
 *   is adapted at the call site (see `selectValue`).
 * - `Dialog` is the project's word for a modal with the rules every dialog in this window shares: Escape and the
 *   backdrop close it, unless it is busy saving, in which case they must not.
 */
import { Modal, Select as MantineSelect, type ModalProps, type SelectProps } from '@mantine/core';
import type { ReactNode } from 'react';
import { usePrefersReducedMotion } from './reduced-motion.ts';
import { EASING_CSS, MOTION } from './motion-tokens.ts';

export {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  Collapse,
  Combobox,
  Divider,
  Drawer,
  Flex,
  Grid,
  Group,
  Loader,
  Menu,
  NumberInput,
  Paper,
  Popover,
  Progress,
  ScrollArea,
  SimpleGrid,
  Skeleton,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
export type { ComboboxItem, SelectProps, TabsProps } from '@mantine/core';

/** One downward chevron; `ui.css` flips it while the dropdown is open. */
function SelectChevron(): ReactNode {
  return (
    <svg className="select-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
    </svg>
  );
}

/**
 * Every dropdown gets the same indicator and check placement. The defaults live here rather than in each call site so
 * a control cannot quietly keep Mantine's double chevron or move its check back to the left.
 */
export function Select(props: SelectProps): ReactNode {
  return (
    <MantineSelect
      checkIconPosition="right"
      rightSectionPointerEvents="none"
      {...props}
      rightSection={props.rightSection ?? <SelectChevron />}
    />
  );
}

/** A legacy `<select>`'s empty value is "nothing chosen"; Mantine's Select spells that `null`. */
export function selectValue(value: string): string | null {
  return value === '' ? null : value;
}

export interface DialogProps {
  opened: boolean;
  onClose(): void;
  title?: ReactNode;
  children: ReactNode;
  /** While a form is saving, neither Escape nor a backdrop click may discard the work. */
  busy?: boolean;
  size?: ModalProps['size'];
}

export function Dialog({
  opened,
  onClose,
  title,
  children,
  busy = false,
  size = 'md',
}: DialogProps): ReactNode {
  // Mantine's own transition is the overlay's owner; nothing else may animate the same properties on it.
  const reduced = usePrefersReducedMotion();
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={title}
      size={size}
      centered
      closeOnClickOutside={!busy}
      closeOnEscape={!busy}
      withCloseButton={!busy}
      transitionProps={{
        duration: reduced ? 0 : MOTION.modal.enter,
        timingFunction: EASING_CSS,
      }}
    >
      {children}
    </Modal>
  );
}

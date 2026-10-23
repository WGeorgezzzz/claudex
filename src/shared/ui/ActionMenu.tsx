import * as React from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Loader2, type LucideIcon } from 'lucide-react';

import { cn } from '@/shared/utils';
import { Button } from '@/shared/ui/Button';
import { useViewportMenuAnchor } from '@/shared/hooks/useViewportMenuAnchor';

type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

export type ActionMenuItem = {
  key: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  loading?: boolean;
  isDanger?: boolean;
  showDividerBefore?: boolean;
  closeOnSelect?: boolean;
};

type ActionMenuProps = {
  label: string;
  items: ActionMenuItem[];
  icon?: LucideIcon;
  ariaLabel?: string;
  align?: 'left' | 'right';
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  disabled?: boolean;
  iconOnly?: boolean;
  portal?: boolean;
  header?: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
};

/** Used by mcp, sidebar and chat for viewport-bounded overflow and export menus. */
export function ActionMenu({
  label,
  items,
  icon: TriggerIcon,
  ariaLabel,
  align = 'right',
  variant = 'outline',
  size = 'sm',
  className,
  triggerClassName,
  menuClassName,
  disabled,
  iconOnly = false,
  portal = true,
  header,
  onOpenChange,
}: ActionMenuProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  // Whether closing should move focus back to the trigger. Set for keyboard
  // (Escape) and item selection, but left false for outside pointer clicks so
  // focus is not stolen from wherever the user clicked.
  const restoreFocusRef = React.useRef(false);
  const focusMenuOnOpenRef = React.useRef(false);
  const wasOpenRef = React.useRef(false);
  const menuId = React.useId();

  const setMenuOpen = React.useCallback((open: boolean) => {
    setIsOpen(open);
    onOpenChange?.(open);
  }, [onOpenChange]);
  const close = React.useCallback(() => setMenuOpen(false), [setMenuOpen]);
  const { triggerRef, menuRef, anchor, updateAnchor } = useViewportMenuAnchor(isOpen, close, 260, 'below', align);

  // Move focus into the menu on open and back to the trigger on a keyboard or
  // selection close, so keyboard and screen-reader navigation match the menu role.
  React.useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
      if (focusMenuOnOpenRef.current) {
        const menu = menuRef.current;
        const firstItem = menu?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])');
        (firstItem ?? menu)?.focus();
      }
      return;
    }

    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      if (restoreFocusRef.current) {
        triggerRef.current?.focus();
      }
      restoreFocusRef.current = false;
    }
  }, [isOpen, menuRef, triggerRef]);

  const runItem = (item: ActionMenuItem) => {
    if (item.disabled || item.loading) {
      return;
    }

    if (item.closeOnSelect !== false) {
      restoreFocusRef.current = true;
      setMenuOpen(false);
    }
    item.onSelect();
  };

  const toggleMenu = () => {
    if (isOpen) {
      setMenuOpen(false);
      return;
    }

    updateAnchor();
    setMenuOpen(true);
  };

  const menu = isOpen && (!portal || anchor) && (
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      aria-label={ariaLabel || label}
      tabIndex={-1}
      data-escape-layer
      className={cn(
        portal ? 'fixed z-[70]' : 'absolute top-full z-50 mt-2',
        'min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg',
        'animate-in fade-in-0 zoom-in-95',
        !portal && (align === 'right' ? 'right-0' : 'left-0'),
        menuClassName,
      )}
      style={portal && anchor ? { ...anchor, width: anchor.maxWidth } : undefined}
    >
      {header}
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <React.Fragment key={item.key}>
            {item.showDividerBefore && <div className="mx-2 my-1 h-px bg-border" />}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled || item.loading}
              onClick={() => runItem(item)}
              className={cn(
                'flex w-full items-start gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors',
                'focus:outline-none focus-visible:bg-accent',
                item.disabled || item.loading
                  ? 'cursor-not-allowed opacity-50'
                  : item.isDanger
                    ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950'
                    : 'hover:bg-accent',
              )}
            >
              {item.loading ? (
                <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin" />
              ) : (
                Icon && <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block font-medium leading-5">{item.label}</span>
                {item.description && (
                  <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                    {item.description}
                  </span>
                )}
              </span>
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );

  return (
    <div className={cn('relative inline-flex', className)}>
      <Button
        ref={triggerRef}
        type="button"
        variant={variant}
        size={size}
        className={triggerClassName}
        disabled={disabled}
        aria-label={ariaLabel || label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        onClick={(event) => {
          focusMenuOnOpenRef.current = event.detail === 0;
          toggleMenu();
        }}
      >
        {TriggerIcon && <TriggerIcon className="h-4 w-4" />}
        {!iconOnly && (
          <>
            <span>{label}</span>
            <ChevronDown className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-180')} />
          </>
        )}
      </Button>

      {portal && typeof document !== 'undefined' ? createPortal(menu, document.body) : menu}
    </div>
  );
}

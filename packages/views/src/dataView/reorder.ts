import { type DragEvent, useRef, useState } from "react";

/**
 * Where a drag lands. `from` is the position being dragged and `to` the position under the
 * pointer; the answer is the destination, or nothing when the move would change no order.
 */
export function reorderedIndex(
  from: number | undefined,
  to: number,
  canMove: (index: number) => boolean,
): number | undefined {
  if (from === undefined || from === to) return undefined;
  return canMove(from) && canMove(to) ? to : undefined;
}

/**
 * Which position a pointer sits at, along a row of items given by their horizontal midpoints: the
 * first item the pointer is left of, and the last position when it is left of none.
 */
export function positionAtPointer(pointerX: number, midpoints: readonly number[]): number {
  const before = midpoints.findIndex((midpoint) => pointerX < midpoint);
  return before === -1 ? Math.max(midpoints.length - 1, 0) : before;
}

/** Drag handlers for one position in a reorderable list. */
export interface ReorderableItemProps {
  draggable: boolean;
  onDragStart: (event: DragEvent) => void;
  onDragOver: (event: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent) => void;
  onDragEnd: () => void;
}

export interface ReorderableList {
  /** True while a drag hovers this position, so the item can show where it would land. */
  isTarget(index: number): boolean;
  /** What the item at `index` spreads onto its element; `label` is the text a drop carries. */
  itemProps(index: number, label: string): ReorderableItemProps;
  /**
   * What the list element spreads onto itself, to accept a drop that lands between items or past
   * the last one. `midpoints` reads the item midpoints out of the list, in order.
   */
  containerProps(midpoints: (event: DragEvent<HTMLElement>) => readonly number[]): {
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
}

/**
 * Dragging an item of a list onto another position. One mechanic: the Data View reorders the
 * tables of its FROM clause and the terms of its ORDER BY the same way, and what differs between
 * them is which positions may move and what moving one means.
 */
export function useReorderable(
  canMove: (index: number) => boolean,
  move: (from: number, to: number) => void,
): ReorderableList {
  const source = useRef<number | undefined>(undefined);
  const [target, setTarget] = useState<number | undefined>(undefined);

  const release = () => {
    source.current = undefined;
    setTarget(undefined);
  };

  return {
    isTarget: (index) => target === index && canMove(index),
    itemProps: (index, label) => ({
      draggable: canMove(index),
      onDragStart: (event) => {
        source.current = index;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", label);
      },
      onDragOver: (event) => {
        if (source.current === undefined || !canMove(index)) return;
        // The drop belongs to this item, not to the list that also accepts drops around it.
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        if (target !== index) setTarget(index);
      },
      onDragLeave: () => setTarget((current) => (current === index ? undefined : current)),
      onDrop: (event) => {
        const to = reorderedIndex(source.current, index, canMove);
        const from = source.current;
        release();
        if (to === undefined || from === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        move(from, to);
      },
      onDragEnd: release,
    }),
    containerProps: (midpoints) => ({
      onDragOver: (event) => {
        if (source.current === undefined) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      },
      onDrop: (event) => {
        const from = source.current;
        if (from === undefined) return;
        event.preventDefault();
        const to = reorderedIndex(
          from,
          positionAtPointer(event.clientX, midpoints(event)),
          canMove,
        );
        release();
        if (to !== undefined) move(from, to);
      },
    }),
  };
}

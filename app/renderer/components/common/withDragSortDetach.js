// @flow

/* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this file,
* You can obtain one at http://mozilla.org/MPL/2.0/. */

const React = require('react')
const throttle = require('lodash.throttle')

const DRAG_DETACH_PX_THRESHOLD_X = 60
const DRAG_DETACH_MS_TIME_BUFFER = 0
const DRAG_DETACH_PX_THRESHOLD_INITIAL = 44
const DRAG_DETACH_PX_THRESHOLD_POSTSORT = 80
const DRAG_PAGEMOVE_PX_THRESHOLD = 38

type Props = {
  /** The first index that is currently displayed and
   * able to be sorted to in a drag operation  */
  firstTabDisplayIndex: number,
  /** The total number of items, including any that
   * are not visible and not able to be dragged to
   */
  totalTabCount: number,
  /** index of this item as it appears in the
   * currently-displayed group
   */
  displayIndex: number,
  /** Count of items in the currently-displayed group */
  displayedTabCount: number,
  /**
   * Called when the item has been dragged away from
   * the list
   */
  onRequestDetach: (number, number) => void,
  /** Called when an item is dragged that has no siblings */
  onDragMoveSingleItem: (number, number) => void,
  /** Called when an item has been dragged past a threshold to a new index */
  onDragChangeIndex: (Object, number) => Boolean,
  /**
   * Request to start dragging. Caller should change the `isDragging` prop to `true`
   * in reponse to this call.
   */
  onStartDragSortDetach: (any, number, number, number, number, number, number, number, number) => void,
  /** unique key for the currently-displayed group (i.e. page) */
  containerKey: any,
  /**
   * this sets up the main events,
   * has the element position track the mouse
   * and sends relevant index changes to the prop functions
   */
  isDragging: Boolean,
  /**
   * Data to pass back to the `onStartDragSortDetach` prop function
   */
  dragData?: any,
  /**
   * A manual override for where the mouse is currently located
   * in relation to the window, on the x-axis. This should be used for a
   * temporary override when there has been a delay in responding to a
   * request to change sort index.
   */
  dragWindowClientX: number,
  /**
   * A manual override for where the mouse is currently located
   * in relation to the window, on the y-axis. This should be used for a
   * temporary override when there has been a delay in responding to a
   * request to change sort index.
   */
  dragWindowClientY: number,
  /**
   * An offset that the item should always have.
   * Exmaple use-case is if the item has been detached,
   * and it should stay at its previous parent offset until
   * the drag operation completes
   */
  detachedFromTabX: number,
  /**
   * Number of pixels relative to the left edge of the element,
   * the drag was initiated by the pointing device at */
  relativeXDragStart: number,
  /** can be used to pause movement processing during a drag opertion */
  dragProcessMoves: Boolean,
  /** whether the item can be detached if dragged past a threshold */
  dragCanDetach: Boolean,
}

// HACK - see the related `createEventFromSendMouseMoveInput` in tabDraggingWindowReducer.js
function translateEventFromSendMouseMoveInput (receivedEvent) {
  return (receivedEvent.x === 1 && receivedEvent.y === 99)
    ? { clientX: receivedEvent.screenX, clientY: receivedEvent.screenY }
    : receivedEvent
}

module.exports = function withDragSortDetach (WrappedComponent: ReactElement, evaluateDraggingItemAndParentSize: Function) {
  class WithDragSortDetach extends React.Component<Props> {
    constructor (props) {
      super(props)
      this.onDragStart = this.onDragStart.bind(this)
      this.onTabDraggingMouseMove = this.onTabDraggingMouseMove.bind(this)
      this.onTabDraggingMouseMoveDetectSortChangeThrottled = throttle(this.onTabDraggingMouseMoveDetectSortChange.bind(this), 1)
    }

    //
    // React Lifecycle Events
    //

    componentDidMount () {
      // if a new tab is already dragging,
      // that means that it has been attached from another window,
      // or moved from another page.
      // All we have to do is move the tab DOM element,
      // and let the store know when the tab should move to another
      // tab's position
      if (this.props.isDragging) {
        // setup tab moving
        this.attachDragSortHandlers()
        // if mount, dragging, and not single tab, then it is either
        // an attach to the window
        // or a change in page
        if (!this.isSingleItem() && this.props.dragWindowClientX) {
          // the tab will attach at the correct index, but the mouse may have moved since the attach was requested,
          // so make sure we move the tab to the mouse position by forwarding the event
          window.requestAnimationFrame(() => {
            this.onTabDraggingMouseMove({ clientX: this.props.dragWindowClientX, clientY: this.props.dragWindowClientY })
          })
        }
      }
    }

    componentWillUnmount () {
      // tear-down tab moving if still setup
      if (this.props.isDragging) {
        this.removeDragSortHandlers()
      }
    }

    componentDidUpdate (prevProps) {
      if (this.props.isDragging && prevProps.isDragging === false) {
        // setup event to move tab DOM element along with
        // mousemove and let the store know when it should
        // move the sort position of the tab.
        // A different process (different because the window the tab is in may change)
        // is firing the event to the store which will check
        // for detach / attach to windows
        this.attachDragSortHandlers()
        // fire sort handler manually with the first update, if we have one
        // since we may have attached but not received mouse event yet
        if (this.props.dragWindowClientX && this.props.dragWindowClientY) {
          window.requestAnimationFrame(() => {
            this.onTabDraggingMouseMove({ clientX: this.props.dragWindowClientX, clientY: this.props.dragWindowClientY })
          })
        }
      } else if (prevProps.isDragging && !this.props.isDragging) {
        // tear-down tab moving
        this.removeDragSortHandlers()
      } else if (this.props.isDragging && this.props.containerKey !== prevProps.containerKey) {
        // handle changing page index during a drag
        // reevaluate anything that's changed when tab is dragged to a new page
        this.draggingTabWidth = null
        window.requestAnimationFrame(() => this.evaluateDraggingTabWidth())
      }

      // mid-drag index change (due to dragging to a new position)
      if (this.props.isDragging && this.props.displayIndex !== prevProps.displayIndex) {
        // allow something to queue an event for after the index change happens
        // e.g. to preventing layout thrashing
        if (this.onNextDragIndexChange) {
          const fn = this.onNextDragIndexChange
          this.onNextDragIndexChange = null
          fn()
        }
        // re-calculate the translation we need to apply to the element
        // after an index change, since the element position will be new
        // but the mouse may have moved the tab away from its new location
        if (this.currentMouseX) {
          this.dragTab({ clientX: this.currentMouseX })
          this.currentMouseX = null
        }
        // we pause the mousemove handler from being able to calculate new index based
        // on drag position, whilst we're waiting for an existing index change
        // Now that the index has changed, we can resume
        this.suspendOrderChangeUntilUpdate = false
      }
    }

    render () {
      return <WrappedComponent
        dragElementRef={element => { this.elementRef = element }}
        onDragStart={this.onDragStart}
        {...this.props}
      />
    }

    //
    // Helpers
    //

    isSingleItem (props = this.props) {
      return props.totalTabCount === 1
    }

    /*
    * Should be called whenever tab size changes. Since Chrome does not yet support ResizeObserver,
    * we have to figure out the times. Luckily it's probably just initial drag start and when
    * then tab page changes
    */
    evaluateDraggingTabWidth () {
      if (!this.elementRef) {
        return
      }
      const itemSizeDetails = evaluateDraggingItemAndParentSize(this.elementRef)
      if (itemSizeDetails) {
        this.draggingTabWidth = itemSizeDetails.draggingTabWidth
        this.nonDraggingTabWidth = itemSizeDetails.nonDraggingTabWidth
        this.parentClientRect = itemSizeDetails.parentClientRect
      }
    }

    //
    // Event(s) to dispatch drag operations to store.
    // Only run by source window
    //

    // Setup this tab window instance as the dragging source
    // moving the tab and orchestrating order changes
    // as well as dispatching events to the store so it can
    // handle detach / attach
    // Because this drag event starts in this window's web context,
    // it will receive locations even outside of the window.
    // If we start monitoring mousemove events in another window, it wouldn't
    // get position updates when the mouse moves outside the window, which we need
    // so we use the event instances started from this window to control the movement
    // in any other window the tab may have been dragged to
    onDragStart (e) {
      e.preventDefault()
      // let the store know where on the tab the mouse is, so it can always
      // keep the tab in the same place under the mouse, regardless of which
      // actual element from which window is being moved
      const dragElementBounds = e.target.getBoundingClientRect()
      const relativeXDragStart = e.clientX - dragElementBounds.left
      const relativeYDragStart = e.clientY - dragElementBounds.top
      this.props.onStartDragSortDetach(
        this.props.dragData,
        e.clientX,
        e.clientY,
        e.screenX,
        e.screenY,
        dragElementBounds.width,
        dragElementBounds.height,
        relativeXDragStart,
        relativeYDragStart
      )
    }

    //
    // Events for drag-sort amongst this tab group
    // Run by any window that receives a dragged tab
    //

    attachDragSortHandlers () {
      // get tab width
      window.requestAnimationFrame(() => this.evaluateDraggingTabWidth())
      // initial distance that has to be travelled outside the tab bar in order to detach the tab
      // (increases after some sorting has happened, as the user may be more 'relaxed' with the mouse)
      this.draggingDetachThreshold = DRAG_DETACH_PX_THRESHOLD_INITIAL

      window.addEventListener('mousemove', this.onTabDraggingMouseMove)
      if (this.isSingleItem() && this.props.detachedFromTabX) {
        this.elementRef.style.setProperty('--dragging-delta-x', this.props.detachedFromTabX + 'px')
      }
    }

    removeDragSortHandlers () {
      this.draggingTabWidth = null
      this.parentClientRect = null
      this.singleTabPosition = null
      this.currentWindowId = null
      this.suspendOrderChangeUntilUpdate = null
      this.whenProcessMoveE = null
      window.removeEventListener('mousemove', this.onTabDraggingMouseMove)
      if (this.draggingDetachTimeout) {
        window.clearTimeout(this.draggingDetachTimeout)
        this.draggingDetachThreshold = null
      }
      this.tabFinishedDragging()
    }

    tabFinishedDragging () {
      // move tab back to it's actual position, from the mouse position
      if (this.elementRef) {
        window.requestAnimationFrame(() => {
          // need to check if element is still around
          if (!this.elementRef) {
            return
          }
          const lastPos = this.elementRef.style.getPropertyValue('--dragging-delta-x')
          if (lastPos !== '') { // default for a property not set is empty string
            this.elementRef.style.removeProperty('--dragging-delta-x')
            this.elementRef.animate([{
              transform: `translateX(${lastPos})`
            }, {
              transform: 'translateX(0)'
            }], {
              duration: 240,
              easing: 'cubic-bezier(0.23, 1, 0.32, 1)'
            })
          }
        })
      }
    }

    onTabDraggingMouseMove (e) {
      e = translateEventFromSendMouseMoveInput(e)
      if (!this.isSingleItem() || !this.props.onDragMoveSingleItem) {
        // move tab with mouse (rAF - smooth)
        this.dragTabMouseMoveFrame = this.dragTabMouseMoveFrame || window.requestAnimationFrame(this.dragTab.bind(this, e))
      }
      if (this.props.dragProcessMoves) {
        if (!this.isSingleItem()) {
          // don't continue if we're about to detach
          // we'll soon get the props change to remove mouse event listeners
          if (!this.hasRequestedDetach) {
            // change order of tabs when passed boundaries (debounced - helps being smooth)
            this.onTabDraggingMouseMoveDetectSortChangeThrottled(e)
          }
        } else {
          this.onTabDraggingMoveSingleTabWindow(e)
        }
      }
    }

    dragTab (e) {
      // cache just in case we need to force the tab to move to the mouse cursor
      // without a mousemove event
      this.currentMouseX = e.clientX
      if (!this.elementRef || !this.parentClientRect) {
        return
      }
      this.dragTabMouseMoveFrame = null
      const relativeLeft = this.props.relativeXDragStart
      // include any gap between parent edge and first tab
      const currentX = this.elementRef.offsetLeft - this.parentClientRect.offsetDifference
      const deltaX = this.currentMouseX - this.parentClientRect.left - currentX - relativeLeft
      this.elementRef.style.setProperty('--dragging-delta-x', deltaX + 'px')
    }

    onTabDraggingMouseMoveDetectSortChange (e) {
      if (!this.parentClientRect || !this.draggingTabWidth) {
        return
      }
      // find when the order should be changed
      // ...but don't if we already have requested it,
      // instead, wait until the order changes
      if (this.suspendOrderChangeUntilUpdate) {
        return
      }
      // assumes all (non-dragging) tabs in this group have same width
      // we need to consider the current drag tab width, and the width of the other tabs
      // as they may differ due to using the width of the tab from the source window
      // during a drag operation
      const dragTabWidth = this.draggingTabWidth
      const tabWidth = this.nonDraggingTabWidth || this.draggingTabWidth
      const tabLeft = e.clientX - this.parentClientRect.left - this.props.relativeXDragStart
      // detect when to ask for detach
      if (this.props.dragCanDetach) {
        // detach threshold is a time thing
        // If it's been outside of the bounds for X time, then we can detach
        const isOutsideBounds =
        e.clientX < 0 - DRAG_DETACH_PX_THRESHOLD_X ||
        e.clientX > this.parentClientRect.windowWidth + DRAG_DETACH_PX_THRESHOLD_X ||
        e.clientY < this.parentClientRect.y - this.draggingDetachThreshold ||
        e.clientY > this.parentClientRect.y + this.parentClientRect.height + this.draggingDetachThreshold
        if (isOutsideBounds) {
          // start a timeout to see if we're still outside, don't restart if we already started one
          this.draggingDetachTimeout = this.draggingDetachTimeout || window.setTimeout(() => {
            this.hasRequestedDetach = true
            this.props.onRequestDetach(tabLeft, this.parentClientRect.top)
          }, DRAG_DETACH_MS_TIME_BUFFER)
          return
        } else {
          // we're not outside, so reset the timer
          if (this.draggingDetachTimeout) {
            window.clearTimeout(this.draggingDetachTimeout)
            this.draggingDetachTimeout = null
          }
        }
      }
      // calculate destination index to move tab to
      // based on coords of dragged tab
      const destinationIndex = this.detectDragIndexPosition(
        tabWidth,
        dragTabWidth,
        tabLeft
      )
      // ask consumer to change the index
      // it can respond that it will make the change async, and we shouldn't ask
      // for a further index change until after the next index change (see cDU for that detection)
      const suspendOrderChangeUntilUpdate = this.props.onDragChangeIndex(this.props.displayIndex, destinationIndex)
      if (suspendOrderChangeUntilUpdate === true) {
        this.suspendOrderChangeUntilUpdate = true
      }
      // if the requested index is different to the current index
      if (this.props.displayIndex !== destinationIndex) {
        // a display index has changed, so increase the threshold
        // required for detach (different axis of movement)
        this.draggingDetachThreshold = DRAG_DETACH_PX_THRESHOLD_POSTSORT
      }
    }

    detectDragIndexPosition (tabWidth, dragTabWidth, tabLeft) {
      const lastIndex = this.props.totalTabCount - 1
      const tabRight = tabLeft + dragTabWidth
      if (tabLeft < 0 - DRAG_PAGEMOVE_PX_THRESHOLD) {
        // tab is past the pagemove left threshold,
        // so ask for the last index of the previous page
        // unless we are already at the first page
        return Math.max(0, this.props.firstTabDisplayIndex - 1)
      } else if (tabRight > this.parentClientRect.width + DRAG_PAGEMOVE_PX_THRESHOLD) {
        // tab is past the pagemove right threshold,
        // so ask for the first index of the next page
        // unless we are already at the last page
        return Math.min(lastIndex, this.props.firstTabDisplayIndex + this.props.displayedTabCount)
      } else {
        // calculate which index within the group a tab would be if it started at
        // the left edge of the dragged tab (do not consider the dragged tab width since it can be different)
        const groupIndexOfTabLeft = Math.floor((tabLeft - (tabWidth / 2)) / tabWidth) + 1
        // make sure the index we want to move the tab is within the allowed range
        return Math.max(
          0,
          Math.min(this.props.totalTabCount - 1, this.props.firstTabDisplayIndex + groupIndexOfTabLeft)
        )
      }
    }

    onTabDraggingMoveSingleTabWindow (e) {
      if (!this.elementRef) {
        return
      }
      // send the store the location of the tab to the window
      // so that it can calculate where to move the window
      // cached
      const { x, y } = this.singleTabPosition = this.singleTabPosition || this.elementRef.getBoundingClientRect()
      if (this.props.onDragMoveSingleItem) {
        this.props.onDragMoveSingleItem(x, y)
      }
    }
    // class end
  }
  // give the component a meaningful name in case the render tree is inspected by a human
  WithDragSortDetach.displayName = `WithDragSortDetach(${WrappedComponent.displayName || WrappedComponent.name || 'Component'})`
  return WithDragSortDetach
}

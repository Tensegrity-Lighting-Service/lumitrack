"""Stage canvas. Scene units are centimetres, so everything can be reasoned
about in real-world dimensions; only the view transform does the zooming."""
from __future__ import annotations

from typing import Optional

from PySide6.QtCore import Qt, QRectF, Signal, QPointF
from PySide6.QtGui import QBrush, QColor, QPainter, QPen, QPixmap, QFont
from PySide6.QtWidgets import (
    QGraphicsEllipseItem, QGraphicsItem, QGraphicsPixmapItem, QGraphicsScene,
    QGraphicsView,
)

POINT_RADIUS_CM = 25.0  # visual radius of a point marker, in stage units


class PointItem(QGraphicsEllipseItem):
    """A draggable marker. Position is the *centre* in stage cm."""

    def __init__(self, point_id: str, label: str, color: str):
        super().__init__(-POINT_RADIUS_CM, -POINT_RADIUS_CM,
                         POINT_RADIUS_CM * 2, POINT_RADIUS_CM * 2)
        self.point_id = point_id
        self.label = label
        self.setBrush(QBrush(QColor(color)))
        self.setPen(QPen(QColor("#101014"), 4))
        self.setFlag(QGraphicsItem.ItemIsMovable, True)
        self.setFlag(QGraphicsItem.ItemIsSelectable, True)
        self.setFlag(QGraphicsItem.ItemSendsGeometryChanges, True)
        self.setZValue(10)
        self._editable = False
        self._notify = None

    def set_editable(self, editable: bool, notify=None):
        self._editable = editable
        self._notify = notify
        self.setFlag(QGraphicsItem.ItemIsMovable, editable)

    def itemChange(self, change, value):
        if (change == QGraphicsItem.ItemPositionHasChanged
                and self._editable and self._notify):
            self._notify(self.point_id, self.pos().x(), self.pos().y())
        return super().itemChange(change, value)

    def paint(self, painter: QPainter, option, widget=None):
        super().paint(painter, option, widget)
        if self.isSelected():
            painter.setPen(QPen(QColor("#ffffff"), 6))
            painter.setBrush(Qt.NoBrush)
            painter.drawEllipse(self.rect().adjusted(-8, -8, 8, 8))


class StageView(QGraphicsView):
    """Shows the stage, an optional floor reference image, and the points."""

    point_moved = Signal(str, float, float)   # point_id, x_cm, y_cm
    selection_changed = Signal(list)          # list of point ids

    def __init__(self, parent=None):
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self.setRenderHint(QPainter.Antialiasing, True)
        self.setDragMode(QGraphicsView.RubberBandDrag)
        self.setBackgroundBrush(QColor("#0c0d10"))
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)

        self._stage_w = 5000.0
        self._stage_h = 3000.0
        self._grid = 50.0
        self._items: dict = {}
        self._floor_item: Optional[QGraphicsPixmapItem] = None
        self._show_grid = True
        self._show_labels = True
        self._edit_mode = False

        self._scene.selectionChanged.connect(self._on_selection_changed)

    # ------------------------------------------------------------ setup --

    def set_stage(self, width_cm: float, height_cm: float, grid_cm: float):
        self._stage_w = max(1.0, width_cm)
        self._stage_h = max(1.0, height_cm)
        self._grid = max(1.0, grid_cm)
        margin = max(self._stage_w, self._stage_h) * 0.12
        self._scene.setSceneRect(QRectF(-margin, -margin,
                                        self._stage_w + margin * 2,
                                        self._stage_h + margin * 2))
        self._place_floor()
        self.viewport().update()

    def set_floor_image(self, path: Optional[str]) -> bool:
        if self._floor_item is not None:
            self._scene.removeItem(self._floor_item)
            self._floor_item = None
        if not path:
            self.viewport().update()
            return True
        pixmap = QPixmap(path)
        if pixmap.isNull():
            return False
        self._floor_item = QGraphicsPixmapItem(pixmap)
        self._floor_item.setZValue(-10)
        self._floor_item.setOpacity(0.75)
        self._floor_item.setTransformationMode(Qt.SmoothTransformation)
        self._scene.addItem(self._floor_item)
        self._place_floor()
        return True

    def _place_floor(self):
        """Stretch the reference image over the stage rectangle."""
        if self._floor_item is None:
            return
        pm = self._floor_item.pixmap()
        if pm.isNull() or pm.width() == 0 or pm.height() == 0:
            return
        self._floor_item.setPos(0, 0)
        self._floor_item.setScale(1.0)
        self._floor_item.setTransformOriginPoint(0, 0)
        sx = self._stage_w / pm.width()
        sy = self._stage_h / pm.height()
        # Uniform scale keeps the plan's aspect ratio; use the smaller factor
        # so nothing overflows the stage, then centre it.
        scale = min(sx, sy)
        self._floor_item.setScale(scale)
        self._floor_item.setPos((self._stage_w - pm.width() * scale) / 2.0,
                                (self._stage_h - pm.height() * scale) / 2.0)

    def set_show_grid(self, show: bool):
        self._show_grid = show
        self.viewport().update()

    def set_show_labels(self, show: bool):
        self._show_labels = show
        self.viewport().update()

    def set_edit_mode(self, editable: bool):
        self._edit_mode = editable
        for item in self._items.values():
            item.set_editable(editable, self._notify_moved)

    def _notify_moved(self, point_id: str, x: float, y: float):
        self.point_moved.emit(point_id, x, y)

    # ------------------------------------------------------------ points --

    def rebuild_points(self, points):
        for item in self._items.values():
            self._scene.removeItem(item)
        self._items.clear()
        for p in points:
            label = str(p.number) if p.number is not None else p.name
            item = PointItem(p.id, label, p.color)
            item.set_editable(self._edit_mode, self._notify_moved)
            item.setVisible(False)
            self._scene.addItem(item)
            self._items[p.id] = item

    def update_positions(self, positions: dict):
        """positions: {point_id: (x_cm, y_cm)}. Points absent are hidden."""
        for pid, item in self._items.items():
            pos = positions.get(pid)
            if pos is None:
                item.setVisible(False)
                continue
            item.setVisible(True)
            if abs(item.pos().x() - pos[0]) > 0.01 or abs(item.pos().y() - pos[1]) > 0.01:
                blocked = item.flags() & QGraphicsItem.ItemSendsGeometryChanges
                item.setFlag(QGraphicsItem.ItemSendsGeometryChanges, False)
                item.setPos(QPointF(pos[0], pos[1]))
                if blocked:
                    item.setFlag(QGraphicsItem.ItemSendsGeometryChanges, True)
        if self._show_labels:
            self.viewport().update()

    def selected_point_ids(self):
        return [i.point_id for i in self._scene.selectedItems() if isinstance(i, PointItem)]

    def _on_selection_changed(self):
        self.selection_changed.emit(self.selected_point_ids())

    # ------------------------------------------------------------- paint --

    def drawBackground(self, painter: QPainter, rect: QRectF):
        super().drawBackground(painter, rect)

        # Stage floor
        stage = QRectF(0, 0, self._stage_w, self._stage_h)
        painter.fillRect(stage, QColor("#15171d"))

        if self._show_grid:
            painter.setPen(QPen(QColor("#232733"), 2))
            x = 0.0
            while x <= self._stage_w:
                painter.drawLine(QPointF(x, 0), QPointF(x, self._stage_h))
                x += self._grid * 4
            y = 0.0
            while y <= self._stage_h:
                painter.drawLine(QPointF(0, y), QPointF(self._stage_w, y))
                y += self._grid * 4

        # Stage outline + centre line
        painter.setPen(QPen(QColor("#4a5164"), 6))
        painter.drawRect(stage)
        painter.setPen(QPen(QColor("#394052"), 3))
        painter.drawLine(QPointF(self._stage_w / 2, 0), QPointF(self._stage_w / 2, self._stage_h))

    def drawForeground(self, painter: QPainter, rect: QRectF):
        super().drawForeground(painter, rect)
        if not self._show_labels:
            return
        scale = self.transform().m11() or 1.0
        font = QFont()
        font.setPointSizeF(max(6.0, 11.0 / scale))
        painter.setFont(font)
        painter.setPen(QPen(QColor("#e8e8ec")))
        for item in self._items.values():
            if not item.isVisible():
                continue
            pos = item.pos()
            painter.drawText(QPointF(pos.x() + POINT_RADIUS_CM * 1.4,
                                     pos.y() - POINT_RADIUS_CM * 0.6),
                             item.label)

    # ------------------------------------------------------------- zoom --

    def wheelEvent(self, event):
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        self.scale(factor, factor)

    def zoom_fit(self):
        margin = max(self._stage_w, self._stage_h) * 0.05
        self.fitInView(QRectF(-margin, -margin,
                              self._stage_w + margin * 2,
                              self._stage_h + margin * 2),
                       Qt.KeepAspectRatio)

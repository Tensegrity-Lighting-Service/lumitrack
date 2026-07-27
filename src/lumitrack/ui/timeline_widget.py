"""Timeline strip: formation blocks over the full project duration, with a
draggable playhead and a time ruler."""
from __future__ import annotations

from PySide6.QtCore import Qt, Signal, QRectF, QPointF
from PySide6.QtGui import QColor, QPainter, QPen, QBrush, QFont
from PySide6.QtWidgets import QWidget, QSizePolicy

RULER_H = 20
BLOCK_TOP = RULER_H + 4


class TimelineWidget(QWidget):
    seek_requested = Signal(float)          # ms
    formation_clicked = Signal(str)         # formation id

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(96)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self._segments = []      # (start_ms, end_ms, formation)
        self._duration_ms = 1000.0
        self._playhead_ms = 0.0
        self._dragging = False
        self._selected_formation_id = None
        self.setMouseTracking(True)

    # --------------------------------------------------------------- api --

    def set_timeline(self, segments, duration_ms: float):
        self._segments = list(segments)
        self._duration_ms = max(1.0, duration_ms)
        self.update()

    def set_playhead(self, t_ms: float):
        if abs(t_ms - self._playhead_ms) < 0.5:
            return
        self._playhead_ms = t_ms
        self.update()

    def set_selected_formation(self, formation_id):
        self._selected_formation_id = formation_id
        self.update()

    # ------------------------------------------------------------ coords --

    def _x_for(self, t_ms: float) -> float:
        return (t_ms / self._duration_ms) * max(1, self.width())

    def _t_for(self, x: float) -> float:
        return max(0.0, min(self._duration_ms, (x / max(1, self.width())) * self._duration_ms))

    # ------------------------------------------------------------ events --

    def mousePressEvent(self, event):
        if event.button() != Qt.LeftButton:
            return
        t = self._t_for(event.position().x())
        if event.position().y() >= BLOCK_TOP:
            for start, end, formation in self._segments:
                if start <= t <= end:
                    self.formation_clicked.emit(formation.id)
                    break
        self._dragging = True
        self.seek_requested.emit(t)

    def mouseMoveEvent(self, event):
        if self._dragging:
            self.seek_requested.emit(self._t_for(event.position().x()))

    def mouseReleaseEvent(self, event):
        self._dragging = False

    # ------------------------------------------------------------- paint --

    def paintEvent(self, _event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        w, h = self.width(), self.height()

        painter.fillRect(0, 0, w, h, QColor("#15171d"))

        self._paint_ruler(painter, w)
        self._paint_blocks(painter, w, h)

        # Playhead
        x = self._x_for(self._playhead_ms)
        painter.setPen(QPen(QColor("#ff4d4f"), 2))
        painter.drawLine(QPointF(x, 0), QPointF(x, h))
        painter.setBrush(QBrush(QColor("#ff4d4f")))
        painter.setPen(Qt.NoPen)
        painter.drawPolygon(QPointF(x - 5, 0), QPointF(x + 5, 0), QPointF(x, 8))

    def _paint_ruler(self, painter: QPainter, w: int):
        painter.fillRect(0, 0, w, RULER_H, QColor("#1b1e26"))
        font = QFont()
        font.setPointSize(7)
        painter.setFont(font)

        total_s = self._duration_ms / 1000.0
        # Pick a tick step that yields a readable number of labels.
        for step in (1, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800):
            if total_s / step <= max(4, w / 70):
                break
        t = 0.0
        while t <= total_s:
            x = self._x_for(t * 1000.0)
            painter.setPen(QPen(QColor("#3a4052"), 1))
            painter.drawLine(QPointF(x, RULER_H - 6), QPointF(x, RULER_H))
            painter.setPen(QPen(QColor("#8a92a6")))
            painter.drawText(QPointF(x + 3, RULER_H - 7),
                             f"{int(t) // 60}:{int(t) % 60:02d}")
            t += step

    def _paint_blocks(self, painter: QPainter, w: int, h: int):
        if not self._segments:
            painter.setPen(QPen(QColor("#5a6070")))
            painter.drawText(QRectF(0, BLOCK_TOP, w, h - BLOCK_TOP),
                             Qt.AlignCenter, "No formations")
            return

        font = QFont()
        font.setPointSize(8)
        painter.setFont(font)
        block_h = h - BLOCK_TOP - 4

        palette = ["#3f5bd6", "#2f7a55", "#8a4fbf", "#b06a2c", "#357f8a"]
        for index, (start, end, formation) in enumerate(self._segments):
            x0 = self._x_for(start)
            x1 = self._x_for(end)
            rect = QRectF(x0, BLOCK_TOP, max(2.0, x1 - x0), block_h)
            base = QColor(palette[index % len(palette)])
            selected = formation.id == self._selected_formation_id
            base.setAlpha(220 if selected else 150)
            painter.fillRect(rect, base)
            painter.setPen(QPen(QColor("#ffffff") if selected else QColor("#00000060"),
                                2 if selected else 1))
            painter.drawRect(rect)

            if rect.width() > 42:
                painter.setPen(QPen(QColor("#ffffff")))
                painter.drawText(rect.adjusted(5, 3, -5, -3),
                                 Qt.AlignTop | Qt.AlignLeft, formation.name)
                painter.setPen(QPen(QColor("#dfe3ee")))
                painter.drawText(rect.adjusted(5, 3, -5, -3),
                                 Qt.AlignBottom | Qt.AlignLeft,
                                 f"{formation.duration_ms / 1000:.1f}s · {formation.easing}")

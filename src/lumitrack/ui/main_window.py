"""Main application window."""
from __future__ import annotations

import os
import uuid
from typing import Optional

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction, QColor, QKeySequence
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QDockWidget, QDoubleSpinBox, QFileDialog, QFormLayout,
    QGroupBox, QHBoxLayout, QLabel, QLineEdit, QListWidget, QListWidgetItem,
    QMainWindow, QMessageBox, QPushButton, QSpinBox, QSplitter, QVBoxLayout,
    QWidget,
)

from ..core.project import Project, Formation, Point, import_stancz
from ..core.timeline import Timeline, EASING_NAMES
from ..core.engine import Transport, PsnBroadcaster
from ..core.timecode import (
    ArtNetTimecodeReceiver, MidiTimecodeReceiver, format_timecode, parse_timecode,
)

UI_REFRESH_MS = 33  # ~30 fps for the interface; PSN has its own clock


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Lumitrack")
        self.resize(1400, 900)

        self.project = Project()
        self.timeline = Timeline(self.project)
        self.transport = Transport()
        self.broadcaster = PsnBroadcaster(self.transport)
        self.broadcaster.set_project(self.project, self.timeline)

        self.artnet_rx = ArtNetTimecodeReceiver(self._on_external_timecode)
        self.midi_rx = MidiTimecodeReceiver(self._on_external_timecode)

        self.current_project_path: Optional[str] = None
        self.selected_formation_id: Optional[str] = None
        self._editing_timecode = False

        self._build_ui()
        self._build_menus()
        self._refresh_all()

        self._timer = QTimer(self)
        self._timer.timeout.connect(self._tick)
        self._timer.start(UI_REFRESH_MS)

    # ----------------------------------------------------------- layout --

    def _build_ui(self):
        from .stage_view import StageView
        from .timeline_widget import TimelineWidget

        central = QWidget()
        layout = QVBoxLayout(central)
        layout.setContentsMargins(8, 8, 8, 8)
        layout.setSpacing(8)

        self.stage_view = StageView()
        self.stage_view.point_moved.connect(self._on_point_moved)

        self.timeline_widget = TimelineWidget()
        self.timeline_widget.seek_requested.connect(self._on_seek)
        self.timeline_widget.formation_clicked.connect(self._on_formation_clicked)

        splitter = QSplitter(Qt.Vertical)
        splitter.addWidget(self.stage_view)
        tl_container = QWidget()
        tl_layout = QVBoxLayout(tl_container)
        tl_layout.setContentsMargins(0, 0, 0, 0)
        tl_layout.addWidget(self._build_transport_bar())
        tl_layout.addWidget(self.timeline_widget)
        splitter.addWidget(tl_container)
        splitter.setStretchFactor(0, 1)
        splitter.setSizes([620, 180])

        layout.addWidget(splitter)
        self.setCentralWidget(central)

        self._build_docks()
        self.statusBar().showMessage("Ready")

    def _build_transport_bar(self) -> QWidget:
        bar = QWidget()
        row = QHBoxLayout(bar)
        row.setContentsMargins(0, 0, 0, 0)

        self.btn_play = QPushButton("Play")
        self.btn_play.setFixedWidth(90)
        self.btn_play.clicked.connect(self._toggle_play)
        row.addWidget(self.btn_play)

        self.timecode_edit = QLineEdit("00:00:00.000")
        self.timecode_edit.setFixedWidth(140)
        self.timecode_edit.setAlignment(Qt.AlignCenter)
        self.timecode_edit.returnPressed.connect(self._apply_typed_timecode)
        self.timecode_edit.editingFinished.connect(lambda: setattr(self, "_editing_timecode", False))
        self.timecode_edit.textEdited.connect(lambda _t: setattr(self, "_editing_timecode", True))
        row.addWidget(self.timecode_edit)

        self.duration_label = QLabel("/ 00:00:00.000")
        row.addWidget(self.duration_label)

        row.addSpacing(16)
        self.edit_mode_check = QCheckBox("Edit positions")
        self.edit_mode_check.toggled.connect(self.stage_view.set_edit_mode)
        row.addWidget(self.edit_mode_check)

        grid_check = QCheckBox("Grid")
        grid_check.setChecked(True)
        grid_check.toggled.connect(self.stage_view.set_show_grid)
        row.addWidget(grid_check)

        labels_check = QCheckBox("Labels")
        labels_check.setChecked(True)
        labels_check.toggled.connect(self.stage_view.set_show_labels)
        row.addWidget(labels_check)

        row.addStretch(1)
        self.sync_label = QLabel("Internal clock")
        row.addWidget(self.sync_label)
        return bar

    def _build_docks(self):
        # ---- Formations ----
        self.formation_list = QListWidget()
        self.formation_list.currentItemChanged.connect(self._on_formation_selected)

        f_box = QWidget()
        f_layout = QVBoxLayout(f_box)
        f_layout.addWidget(self.formation_list)

        form = QFormLayout()
        self.formation_name = QLineEdit()
        self.formation_name.editingFinished.connect(self._apply_formation_edits)
        self.formation_duration = QDoubleSpinBox()
        self.formation_duration.setRange(0.0, 3600.0)
        self.formation_duration.setDecimals(2)
        self.formation_duration.setSuffix(" s")
        self.formation_duration.editingFinished.connect(self._apply_formation_edits)
        self.formation_easing = QComboBox()
        self.formation_easing.addItems(EASING_NAMES)
        self.formation_easing.currentTextChanged.connect(lambda _t: self._apply_formation_edits())
        form.addRow("Name", self.formation_name)
        form.addRow("Duration", self.formation_duration)
        form.addRow("Easing", self.formation_easing)
        f_layout.addLayout(form)

        btn_row = QHBoxLayout()
        add_btn = QPushButton("Add")
        add_btn.clicked.connect(self._add_formation)
        dup_btn = QPushButton("Duplicate")
        dup_btn.clicked.connect(self._duplicate_formation)
        del_btn = QPushButton("Delete")
        del_btn.clicked.connect(self._delete_formation)
        store_btn = QPushButton("Store positions")
        store_btn.setToolTip("Write the points' current on-stage positions into this formation")
        store_btn.clicked.connect(self._store_positions)
        for b in (add_btn, dup_btn, del_btn):
            btn_row.addWidget(b)
        f_layout.addLayout(btn_row)
        f_layout.addWidget(store_btn)

        dock_f = QDockWidget("Formations", self)
        dock_f.setWidget(f_box)
        self.addDockWidget(Qt.LeftDockWidgetArea, dock_f)

        # ---- Points ----
        self.point_list = QListWidget()
        p_box = QWidget()
        p_layout = QVBoxLayout(p_box)
        p_layout.addWidget(self.point_list)
        add_point_btn = QPushButton("Add point")
        add_point_btn.clicked.connect(self._add_point)
        p_layout.addWidget(add_point_btn)
        dock_p = QDockWidget("Points", self)
        dock_p.setWidget(p_box)
        self.addDockWidget(Qt.LeftDockWidgetArea, dock_p)

        # ---- Output / sync ----
        dock_o = QDockWidget("Output", self)
        dock_o.setWidget(self._build_output_panel())
        self.addDockWidget(Qt.RightDockWidgetArea, dock_o)

    def _build_output_panel(self) -> QWidget:
        container = QWidget()
        outer = QVBoxLayout(container)

        # --- PSN ---
        psn_box = QGroupBox("PSN output")
        psn_form = QFormLayout(psn_box)
        self.psn_ip = QLineEdit("236.10.10.10")
        self.psn_port = QSpinBox(); self.psn_port.setRange(1, 65535); self.psn_port.setValue(56565)
        self.psn_iface = QLineEdit("0.0.0.0")
        self.psn_iface.setToolTip("Local interface to send from. Set this on a multi-NIC FOH machine.")
        self.psn_rate = QSpinBox(); self.psn_rate.setRange(1, 120); self.psn_rate.setValue(30)
        self.psn_rate.setSuffix(" Hz")
        self.psn_name = QLineEdit("Lumitrack")
        psn_form.addRow("Multicast IP", self.psn_ip)
        psn_form.addRow("Port", self.psn_port)
        psn_form.addRow("Interface", self.psn_iface)
        psn_form.addRow("Rate", self.psn_rate)
        psn_form.addRow("System name", self.psn_name)

        self.btn_psn = QPushButton("Start PSN")
        self.btn_psn.setCheckable(True)
        self.btn_psn.toggled.connect(self._toggle_psn)
        psn_form.addRow(self.btn_psn)
        self.psn_status = QLabel("stopped")
        psn_form.addRow("Status", self.psn_status)
        outer.addWidget(psn_box)

        # --- Coordinate transform ---
        tr_box = QGroupBox("Coordinates")
        tr_form = QFormLayout(tr_box)
        self.origin_x = QDoubleSpinBox(); self.origin_x.setRange(-100000, 100000); self.origin_x.setSuffix(" cm")
        self.origin_y = QDoubleSpinBox(); self.origin_y.setRange(-100000, 100000); self.origin_y.setSuffix(" cm")
        self.z_height = QDoubleSpinBox(); self.z_height.setRange(-100, 100); self.z_height.setDecimals(2); self.z_height.setSuffix(" m")
        self.invert_x = QCheckBox("Invert X")
        self.invert_y = QCheckBox("Invert Y")
        self.swap_xy = QCheckBox("Swap X/Y")
        centre_btn = QPushButton("Centre on stage")
        centre_btn.clicked.connect(self._centre_origin)
        tr_form.addRow("Origin X", self.origin_x)
        tr_form.addRow("Origin Y", self.origin_y)
        tr_form.addRow("Z height", self.z_height)
        tr_form.addRow(self.invert_x)
        tr_form.addRow(self.invert_y)
        tr_form.addRow(self.swap_xy)
        tr_form.addRow(centre_btn)
        for w in (self.origin_x, self.origin_y, self.z_height):
            w.valueChanged.connect(self._apply_output_config)
        for c in (self.invert_x, self.invert_y, self.swap_xy):
            c.toggled.connect(self._apply_output_config)
        for w in (self.psn_ip, self.psn_name, self.psn_iface):
            w.editingFinished.connect(self._apply_output_config)
        for w in (self.psn_port, self.psn_rate):
            w.valueChanged.connect(self._apply_output_config)
        outer.addWidget(tr_box)

        # --- Timecode input ---
        tc_box = QGroupBox("Timecode input")
        tc_form = QFormLayout(tc_box)
        self.tc_source = QComboBox()
        self.tc_source.addItems(["Internal clock", "Art-Net timecode", "MIDI timecode (MTC)"])
        self.tc_source.currentIndexChanged.connect(self._change_timecode_source)
        self.tc_offset = QDoubleSpinBox()
        self.tc_offset.setRange(-86400, 86400)
        self.tc_offset.setDecimals(3)
        self.tc_offset.setSuffix(" s")
        self.tc_offset.setToolTip("Incoming timecode minus this offset = project time")
        self.tc_offset.valueChanged.connect(self._apply_timecode_offset)
        self.tc_status = QLabel("internal")
        tc_form.addRow("Source", self.tc_source)
        tc_form.addRow("Offset", self.tc_offset)
        tc_form.addRow("Status", self.tc_status)
        outer.addWidget(tc_box)

        outer.addStretch(1)
        return container

    def _build_menus(self):
        file_menu = self.menuBar().addMenu("&File")

        act_new = QAction("&New", self); act_new.setShortcut(QKeySequence.New)
        act_new.triggered.connect(self._new_project)
        act_open = QAction("&Open project…", self); act_open.setShortcut(QKeySequence.Open)
        act_open.triggered.connect(self._open_project)
        act_save = QAction("&Save", self); act_save.setShortcut(QKeySequence.Save)
        act_save.triggered.connect(self._save_project)
        act_save_as = QAction("Save &as…", self)
        act_save_as.triggered.connect(lambda: self._save_project(force_dialog=True))
        act_import = QAction("&Import .stancz…", self)
        act_import.triggered.connect(self._import_stancz)
        act_floor = QAction("Set &floor reference image…", self)
        act_floor.triggered.connect(self._choose_floor_image)
        act_quit = QAction("&Quit", self); act_quit.setShortcut(QKeySequence.Quit)
        act_quit.triggered.connect(self.close)

        for a in (act_new, act_open, act_save, act_save_as):
            file_menu.addAction(a)
        file_menu.addSeparator()
        file_menu.addAction(act_import)
        file_menu.addAction(act_floor)
        file_menu.addSeparator()
        file_menu.addAction(act_quit)

        view_menu = self.menuBar().addMenu("&View")
        act_fit = QAction("Zoom to &fit", self)
        act_fit.setShortcut("Ctrl+0")
        act_fit.triggered.connect(self.stage_view.zoom_fit)
        view_menu.addAction(act_fit)

        act_play = QAction("Play / Pause", self)
        act_play.setShortcut(Qt.Key_Space)
        act_play.triggered.connect(self._toggle_play)
        self.addAction(act_play)

    # ------------------------------------------------------- file actions --

    def _new_project(self):
        self._set_project(Project(), None)

    def _open_project(self):
        path, _ = QFileDialog.getOpenFileName(self, "Open project", "",
                                              "Editor project (*.spsn *.json)")
        if not path:
            return
        try:
            self._set_project(Project.load(path), path)
        except Exception as exc:
            QMessageBox.critical(self, "Open failed", str(exc))

    def _save_project(self, force_dialog: bool = False):
        path = self.current_project_path
        if force_dialog or not path:
            path, _ = QFileDialog.getSaveFileName(self, "Save project", "",
                                                  "Editor project (*.spsn)")
            if not path:
                return
            if not os.path.splitext(path)[1]:
                path += ".spsn"
        try:
            self.project.save(path)
            self.current_project_path = path
            self.statusBar().showMessage(f"Saved {os.path.basename(path)}", 4000)
        except Exception as exc:
            QMessageBox.critical(self, "Save failed", str(exc))

    def _import_stancz(self):
        path, _ = QFileDialog.getOpenFileName(self, "Import Stancz bundle", "",
                                              "Stancz project (*.stancz)")
        if not path:
            return
        try:
            project = import_stancz(path)
        except Exception as exc:
            QMessageBox.critical(self, "Import failed", str(exc))
            return
        self._set_project(project, None)
        self.statusBar().showMessage(
            f"Imported {len(project.points)} points, {len(project.formations)} formations", 6000)

    def _choose_floor_image(self):
        path, _ = QFileDialog.getOpenFileName(self, "Floor reference image", "",
                                              "Images (*.png *.jpg *.jpeg *.bmp *.webp)")
        if not path:
            return
        if not self.stage_view.set_floor_image(path):
            QMessageBox.warning(self, "Image", "That file could not be loaded as an image.")
            return
        self.project.floor_image_path = path

    def _set_project(self, project: Project, path: Optional[str]):
        self.project = project
        self.timeline = Timeline(project)
        self.broadcaster.set_project(project, self.timeline)
        self.current_project_path = path
        self.selected_formation_id = project.formations[0].id if project.formations else None
        self.transport.seek(0.0)
        self.stage_view.set_floor_image(project.floor_image_path)
        self._refresh_all()
        self.stage_view.zoom_fit()

    # --------------------------------------------------------- refreshing --

    def _refresh_all(self):
        self.transport.set_duration(self.project.duration_ms)
        self.stage_view.set_stage(self.project.stage_width_cm,
                                  self.project.stage_height_cm,
                                  self.project.grid_size_cm)
        self.stage_view.rebuild_points(self.project.points)
        self.timeline_widget.set_timeline(self.timeline.segments, self.timeline.duration_ms)
        self.timeline_widget.set_selected_formation(self.selected_formation_id)
        self._refresh_formation_list()
        self._refresh_point_list()
        self.duration_label.setText("/ " + format_timecode(self.project.duration_ms))
        title = self.project.name or "Untitled"
        self.setWindowTitle(f"Lumitrack — {title}")

    def _refresh_formation_list(self):
        self.formation_list.blockSignals(True)
        self.formation_list.clear()
        for f in self.project.formations:
            item = QListWidgetItem(f"{f.order:>4}  {f.name}")
            item.setData(Qt.UserRole, f.id)
            self.formation_list.addItem(item)
            if f.id == self.selected_formation_id:
                self.formation_list.setCurrentItem(item)
        self.formation_list.blockSignals(False)
        self._load_formation_fields()

    def _refresh_point_list(self):
        self.point_list.clear()
        for p in self.project.points:
            label = f"{p.number if p.number is not None else '-'}  {p.name}"
            item = QListWidgetItem(label)
            item.setForeground(QColor(p.color))
            item.setData(Qt.UserRole, p.id)
            self.point_list.addItem(item)

    def _current_formation(self) -> Optional[Formation]:
        for f in self.project.formations:
            if f.id == self.selected_formation_id:
                return f
        return None

    def _load_formation_fields(self):
        f = self._current_formation()
        for w in (self.formation_name, self.formation_duration, self.formation_easing):
            w.blockSignals(True)
        if f is None:
            self.formation_name.setText("")
            self.formation_duration.setValue(0.0)
        else:
            self.formation_name.setText(f.name)
            self.formation_duration.setValue(f.duration_ms / 1000.0)
            index = self.formation_easing.findText(f.easing)
            self.formation_easing.setCurrentIndex(index if index >= 0 else 0)
        for w in (self.formation_name, self.formation_duration, self.formation_easing):
            w.blockSignals(False)

    # ------------------------------------------------------------- ticks --

    def _tick(self):
        t = self.transport.now_ms()
        positions = self.timeline.positions_at(t)
        self.stage_view.update_positions(positions)
        self.timeline_widget.set_playhead(t)
        if not self._editing_timecode:
            fps = self.transport.last_external_fps if self.transport.external_sync else None
            self.timecode_edit.setText(format_timecode(t, fps))
        self.btn_play.setText("Pause" if self.transport.playing else "Play")

        if self.broadcaster.running:
            err = self.broadcaster.last_error
            self.psn_status.setText(
                f"error: {err}" if err else
                f"sending · {len(self.broadcaster.build_trackers(t))} trackers"
            )

        if self.transport.external_sync:
            live = self.transport.external_is_live()
            self.tc_status.setText("locked" if live else "no signal")
            self.sync_label.setText(
                f"External TC {'locked' if live else '— no signal'}")
        else:
            self.sync_label.setText("Internal clock")

    # ------------------------------------------------------------ actions --

    def _toggle_play(self):
        if self.transport.external_sync:
            self.statusBar().showMessage(
                "Transport is slaved to external timecode; switch the source to Internal to play manually.", 5000)
            return
        self.transport.toggle()

    def _on_seek(self, t_ms: float):
        self.transport.seek(t_ms)

    def _apply_typed_timecode(self):
        try:
            ms = parse_timecode(self.timecode_edit.text())
        except ValueError as exc:
            self.statusBar().showMessage(str(exc), 4000)
            return
        self._editing_timecode = False
        self.transport.seek(ms)

    def _on_formation_clicked(self, formation_id: str):
        self.selected_formation_id = formation_id
        self.timeline_widget.set_selected_formation(formation_id)
        self._refresh_formation_list()

    def _on_formation_selected(self, current, _previous):
        if current is None:
            return
        self.selected_formation_id = current.data(Qt.UserRole)
        self.timeline_widget.set_selected_formation(self.selected_formation_id)
        self._load_formation_fields()

    def _apply_formation_edits(self):
        f = self._current_formation()
        if f is None:
            return
        f.name = self.formation_name.text()
        f.duration_ms = self.formation_duration.value() * 1000.0
        f.easing = self.formation_easing.currentText()
        self.timeline.rebuild()
        self.transport.set_duration(self.project.duration_ms)
        self.timeline_widget.set_timeline(self.timeline.segments, self.timeline.duration_ms)
        self.duration_label.setText("/ " + format_timecode(self.project.duration_ms))
        self._refresh_formation_list()

    def _add_formation(self):
        f = Formation(id=str(uuid.uuid4())[:8], name=f"Formation {len(self.project.formations) + 1}",
                      order=self.project.next_order(), duration_ms=3000.0, easing="linear")
        previous = self.project.formations[-1] if self.project.formations else None
        if previous:
            f.positions = dict(previous.positions)
        self.project.formations.append(f)
        self.selected_formation_id = f.id
        self.timeline.rebuild()
        self._refresh_all()

    def _duplicate_formation(self):
        src = self._current_formation()
        if src is None:
            return
        f = Formation(id=str(uuid.uuid4())[:8], name=f"{src.name} copy",
                      order=self.project.next_order(), duration_ms=src.duration_ms,
                      easing=src.easing, positions=dict(src.positions))
        self.project.formations.append(f)
        self.selected_formation_id = f.id
        self.timeline.rebuild()
        self._refresh_all()

    def _delete_formation(self):
        f = self._current_formation()
        if f is None:
            return
        self.project.formations.remove(f)
        self.selected_formation_id = (
            self.project.formations[0].id if self.project.formations else None)
        self.timeline.rebuild()
        self._refresh_all()

    def _store_positions(self):
        """Freeze whatever is currently on stage into the selected formation."""
        f = self._current_formation()
        if f is None:
            return
        positions = self.timeline.positions_at(self.transport.now_ms())
        f.positions = dict(positions)
        self.statusBar().showMessage(
            f"Stored {len(positions)} positions into '{f.name}'", 4000)

    def _add_point(self):
        number = max([p.number or 0 for p in self.project.points], default=0) + 1
        point = Point(id=str(uuid.uuid4())[:8], name=f"Point {number}", number=number)
        self.project.points.append(point)
        f = self._current_formation()
        if f is not None:
            f.positions[point.id] = (self.project.stage_width_cm / 2,
                                     self.project.stage_height_cm / 2)
        self._refresh_all()

    def _on_point_moved(self, point_id: str, x_cm: float, y_cm: float):
        f = self._current_formation()
        if f is None:
            return
        f.positions[point_id] = (x_cm, y_cm)

    # ------------------------------------------------------------ output --

    def _centre_origin(self):
        self.origin_x.setValue(self.project.stage_width_cm / 2.0)
        self.origin_y.setValue(self.project.stage_height_cm / 2.0)

    def _apply_output_config(self):
        t = self.broadcaster.transform
        t.origin_x_cm = self.origin_x.value()
        t.origin_y_cm = self.origin_y.value()
        t.z_m = self.z_height.value()
        t.invert_x = self.invert_x.isChecked()
        t.invert_y = self.invert_y.isChecked()
        t.swap_xy = self.swap_xy.isChecked()
        self.broadcaster.configure(
            mcast_ip=self.psn_ip.text().strip() or "236.10.10.10",
            port=self.psn_port.value(),
            iface_ip=self.psn_iface.text().strip() or "0.0.0.0",
            rate_hz=self.psn_rate.value(),
            system_name=self.psn_name.text().strip() or "Lumitrack",
        )

    def _toggle_psn(self, checked: bool):
        if checked:
            self._apply_output_config()
            if self.broadcaster.start():
                self.btn_psn.setText("Stop PSN")
                self.psn_status.setText("sending")
            else:
                self.btn_psn.setChecked(False)
                QMessageBox.warning(self, "PSN",
                                    f"Could not start sending:\n{self.broadcaster.last_error}")
        else:
            self.broadcaster.stop()
            self.btn_psn.setText("Start PSN")
            self.psn_status.setText("stopped")

    # ---------------------------------------------------------- timecode --

    def _apply_timecode_offset(self, value: float):
        self.project.timecode_offset_ms = value * 1000.0

    def _on_external_timecode(self, ms: float, fps: float):
        """Called from a receiver thread — keep it cheap and thread-safe."""
        self.transport.apply_external(ms - self.project.timecode_offset_ms, fps)

    def _change_timecode_source(self, index: int):
        self.artnet_rx.stop()
        self.midi_rx.stop()
        self.transport.external_sync = False

        if index == 0:
            self.tc_status.setText("internal")
            return

        if index == 1:
            if self.artnet_rx.start():
                self.transport.external_sync = True
                self.tc_status.setText("listening on UDP 6454")
            else:
                self.tc_source.setCurrentIndex(0)
                QMessageBox.warning(self, "Art-Net timecode",
                                    f"Could not bind UDP 6454:\n{self.artnet_rx.last_error}")
            return

        if index == 2:
            if not MidiTimecodeReceiver.is_available():
                self.tc_source.setCurrentIndex(0)
                QMessageBox.information(
                    self, "MIDI timecode",
                    "MTC needs the optional packages:\n\n    pip install mido python-rtmidi")
                return
            if self.midi_rx.start():
                self.transport.external_sync = True
                self.tc_status.setText(f"MTC: {self.midi_rx.port_name}")
            else:
                self.tc_source.setCurrentIndex(0)
                QMessageBox.warning(self, "MIDI timecode",
                                    f"Could not open a MIDI input:\n{self.midi_rx.last_error}")

    # ------------------------------------------------------------- close --

    def closeEvent(self, event):
        self._timer.stop()
        self.broadcaster.stop()
        self.artnet_rx.stop()
        self.midi_rx.stop()
        super().closeEvent(event)

"""Entry point: python -m lumitrack"""
from __future__ import annotations

import sys


DARK_QSS = """
QWidget { background: #14161a; color: #e8e8ec; font-size: 12px; }
QMainWindow::separator { background: #2b2f38; width: 3px; height: 3px; }
QGroupBox {
    border: 1px solid #2b2f38; border-radius: 6px;
    margin-top: 14px; padding-top: 10px;
}
QGroupBox::title {
    subcontrol-origin: margin; left: 10px; padding: 0 4px;
    color: #8a92a6; font-weight: 600;
}
QLineEdit, QSpinBox, QDoubleSpinBox, QComboBox, QListWidget {
    background: #1c1f26; border: 1px solid #333845;
    border-radius: 5px; padding: 4px 6px; selection-background-color: #4f6df5;
}
QPushButton {
    background: #2a2e37; border: 1px solid #3a3f4a;
    border-radius: 5px; padding: 6px 14px;
}
QPushButton:hover { background: #343946; }
QPushButton:checked { background: #4f6df5; border-color: #4f6df5; }
QDockWidget::title { background: #1b1e26; padding: 6px; }
QMenuBar, QMenu { background: #1b1e26; }
QMenu::item:selected, QMenuBar::item:selected { background: #4f6df5; }
QStatusBar { background: #1b1e26; color: #9ea4b0; }
"""


def main() -> int:
    from PySide6.QtWidgets import QApplication
    from .ui.main_window import MainWindow

    app = QApplication(sys.argv)
    app.setApplicationName("Lumitrack")
    app.setOrganizationName("Lumitrack")
    app.setStyle("Fusion")
    app.setStyleSheet(DARK_QSS)

    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())

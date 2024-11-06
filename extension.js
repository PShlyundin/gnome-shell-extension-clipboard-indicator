import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GLib from 'gi://GLib';

import * as AnimationUtils from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Registry, ClipboardEntry } from './registry.js';
import { DialogManager } from './confirmDialog.js';
import { PrefsFields } from './constants.js';
import { Keyboard } from './keyboard.js';

const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;

const INDICATOR_ICON = 'edit-paste-symbolic';

let DELAYED_SELECTION_TIMEOUT = 750;
let MAX_REGISTRY_LENGTH       = 15;
let MAX_ENTRY_LENGTH          = 50;
let CACHE_ONLY_FAVORITE       = false;
let DELETE_ENABLED            = true;
let MOVE_ITEM_FIRST           = false;
let ENABLE_KEYBINDING         = true;
let PRIVATEMODE               = false;
let NOTIFY_ON_COPY            = true;
let CONFIRM_ON_CLEAR          = true;
let MAX_TOPBAR_LENGTH         = 15;
let TOPBAR_DISPLAY_MODE       = 1; //0 - only icon, 1 - only clipboard content, 2 - both, 3 - neither
let CLEAR_ON_BOOT             = false;
let DISABLE_DOWN_ARROW        = false;
let STRIP_TEXT                = false;
let KEEP_SELECTED_ON_CLEAR    = false;
let PASTE_BUTTON              = true;
let PINNED_ON_BOTTOM          = false;

export default class ClipboardIndicatorExtension extends Extension {
    enable () {
        this.clipboardIndicator = new ClipboardIndicator({
            clipboard: St.Clipboard.get_default(),
            settings: this.getSettings(),
            openSettings: this.openPreferences,
            uuid: this.uuid
        });

        Main.panel.addToStatusArea('clipboardIndicator', this.clipboardIndicator, 1);
    }

    disable () {
        this.clipboardIndicator.destroy();
        this.clipboardIndicator = null;
    }
}

const ClipboardIndicator = GObject.registerClass({
    GTypeName: 'ClipboardIndicator'
}, class ClipboardIndicator extends PanelMenu.Button {
    #refreshInProgress = false;

    destroy () {
        this._disconnectSettings();
        this._unbindShortcuts();
        this._disconnectSelectionListener();
        this._clearDelayedSelectionTimeout();
        this.#clearTimeouts();
        this.dialogManager.destroy();
        this.keyboard.destroy();

        if (this._keyPressEventId) {
            global.stage.disconnect(this._keyPressEventId);
            this._keyPressEventId = null;
        }

        super.destroy();
    }

    _init (extension) {
        super._init(0.0, "ClipboardIndicator");
        this.extension = extension;
        this.registry = new Registry(extension);
        
        // Загружаем конфигурацию workspace'ов
        const config = this.registry.loadWorkspacesConfig();
        if (!config) {
            console.error('Failed to load workspace config');
            this.workspaces = ['Workspace1', 'Workspace2', 'Workspace3'];
            this.activeWorkspace = 'Workspace1';
        } else {
            this.workspaces = config.workspaces;
            this.activeWorkspace = config.activeWorkspace;
        }
        
        this.keyboard = new Keyboard();
        this._settingsChangedId = null;
        this._selectionOwnerChangedId = null;
        this._historyLabel = null;
        this._buttonText = null;
        this._disableDownArrow = null;

        this._shortcutsBindingIds = [];
        this.clipItemsRadioGroup = [];

        let hbox = new St.BoxLayout({
            style_class: 'panel-status-menu-box clipboard-indicator-hbox'
        });

        this.hbox = hbox;

        this.icon = new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon clipboard-indicator-icon'
        });

        this._buttonText = new St.Label({
            text: _('Text will be here'),
            y_align: Clutter.ActorAlign.CENTER
        });

        this._buttonImgPreview = new St.Bin({
            style_class: 'clipboard-indicator-topbar-preview'
        });

        hbox.add_child(this.icon);
        hbox.add_child(this._buttonText);
        hbox.add_child(this._buttonImgPreview);
        this._downArrow = PopupMenu.arrowIcon(St.Side.BOTTOM);
        hbox.add_child(this._downArrow);
        this.add_child(hbox);
        this._createHistoryLabel();
        this._loadSettings();

        if (CLEAR_ON_BOOT) this.registry.clearCacheFolder();

        this.dialogManager = new DialogManager();
        this._buildMenu().then(() => {
            this._updateTopbarLayout();
            this._setupListener();
        });
    }

    #updateIndicatorContent(entry) {
        if (this.preventIndicatorUpdate || (TOPBAR_DISPLAY_MODE !== 1 && TOPBAR_DISPLAY_MODE !== 2)) {
            return;
        }

        if (!entry || PRIVATEMODE) {
            this._buttonImgPreview.destroy_all_children();
            this._buttonText.set_text("...")
        } else {
            if (entry.isText()) {
                this._buttonText.set_text(this._truncate(entry.getStringValue(), MAX_TOPBAR_LENGTH));
                this._buttonImgPreview.destroy_all_children();
            }
            else if (entry.isImage()) {
                this._buttonText.set_text('');
                this._buttonImgPreview.destroy_all_children();
                this.registry.getEntryAsImage(entry, this.activeWorkspace).then(img => {
                    if (img) {
                        img.add_style_class_name('clipboard-indicator-img-preview');
                        img.y_align = Clutter.ActorAlign.CENTER;

                        // icon only renders properly in setTimeout for some arcane reason
                        this._imagePreviewTimeout = setTimeout(() => {
                            this._buttonImgPreview.set_child(img);
                        }, 0);
                    }
                });
            }
        }
    }

    async _buildMenu () {
        try {
            let that = this;
            const clipHistory = await this._getCache();
            let lastIdx = clipHistory.length - 1;
            let clipItemsArr = that.clipItemsRadioGroup;

            /* This create the search entry, which is add to a menuItem.
            The searchEntry is connected to the function for research.
            The menu itself is connected to some shitty hack in order to
            grab the focus of the keyboard. */
            that._entryItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false
            });
            that.searchEntry = new St.Entry({
                name: 'searchEntry',
                style_class: 'search-entry',
                can_focus: true,
                hint_text: _('Type here to search...'),
                track_hover: true,
                x_expand: true,
                y_expand: true,
                primary_icon: new St.Icon({ icon_name: 'edit-find-symbolic' })
            });

            that.searchEntry.get_clutter_text().connect(
                'text-changed',
                that._onSearchTextChanged.bind(that)
            );

            that._entryItem.add_child(that.searchEntry);

            that.menu.connect('open-state-changed', (self, open) => {
                if (open) {
                    // Добавляем обработчик клавиш при открытии меню
                    this._keyPressEventId = global.stage.connect('key-press-event', (actor, event) => {
                        const symbol = event.get_key_symbol();
                        const modifiers = event.get_state();
                        const controlPressed = (modifiers & Clutter.ModifierType.CONTROL_MASK) !== 0;

                        if (controlPressed) {
                            switch (symbol) {
                                case Clutter.KEY_bracketleft:  // Ctrl + [
                                    this._switchToPreviousWorkspace();
                                    return Clutter.EVENT_STOP;
                                case Clutter.KEY_bracketright: // Ctrl + ]
                                    this._switchToNextWorkspace();
                                    return Clutter.EVENT_STOP;
                            }
                        }
                        return Clutter.EVENT_PROPAGATE;
                    });

                    // Существующий код фокуса
                    if (this.clipItemsRadioGroup.length > 0) {
                        that.searchEntry.set_text('');
                        global.stage.set_key_focus(that.searchEntry);
                    } else {
                        global.stage.set_key_focus(that.privateModeMenuItem);
                    }
                } else {
                    // Отключаем обработчик при закрытии меню
                    if (this._keyPressEventId) {
                        global.stage.disconnect(this._keyPressEventId);
                        this._keyPressEventId = null;
                    }
                }
            }, 50);

            // Add workspace buttons container
            const workspaceButtonsBox = new St.BoxLayout({
                style_class: 'workspace-buttons-container',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL
            });
            
            // Create workspace buttons for each saved workspace
            for (let workspaceName of this.workspaces) {
                const buttonContent = new St.BoxLayout({
                    style_class: 'workspace-button-content'
                });
                
                const label = new St.Label({
                    text: workspaceName,
                    y_align: Clutter.ActorAlign.CENTER
                });
                
                // Добвляем кнопку редактирования
                const editIcon = new St.Icon({
                    icon_name: 'document-edit-symbolic',
                    style_class: 'workspace-edit-icon',
                    icon_size: 14
                });
                
                const editButton = new St.Button({
                    style_class: 'workspace-edit-button',
                    child: editIcon
                });
                
                const deleteIcon = new St.Icon({
                    icon_name: 'window-close-symbolic',
                    style_class: 'workspace-delete-icon',
                    icon_size: 14
                });
                
                const deleteButton = new St.Button({
                    style_class: 'workspace-delete-button',
                    child: deleteIcon
                });
                
                const button = new St.Button({
                    style_class: 'workspace-button',
                    x_expand: true
                });
                
                buttonContent.add_child(label);
                buttonContent.add_child(editButton);
                buttonContent.add_child(deleteButton);
                button.set_child(buttonContent);
                
                // Добавляем обработчик для кнопки редактирования
                editButton.connect('clicked', () => {
                    // Сохраняем старое имя
                    const oldName = workspaceName;
                    
                    // Удаляем label и добавляем поле ввода
                    buttonContent.remove_child(label);
                    const entry = new St.Entry({
                        style_class: 'workspace-name-entry',
                        text: workspaceName,
                        can_focus: true
                    });
                    buttonContent.insert_child_at_index(entry, 0);
                    
                    // Скрываем кнопки редактирования и удаления во время редактирования
                    editButton.hide();
                    deleteButton.hide();
                    
                    // Устанавливаем фокус на поле ввода
                    global.stage.set_key_focus(entry);
                    
                    // Обработчик завершения редактирования
                    entry.clutter_text.connect('activate', async () => {
                        const newName = entry.get_text().trim();
                        if (newName && newName !== oldName) {
                            // Обновляем имя в массиве
                            const index = this.workspaces.indexOf(oldName);
                            if (index !== -1) {
                                // Пробуем переименовать workspace в registry
                                if (await this.registry.renameWorkspace(oldName, newName)) {
                                    this.workspaces[index] = newName;
                                    
                                    // Если редактируем активный workspace, обновляем его имя
                                    if (this.activeWorkspace === oldName) {
                                        this.activeWorkspace = newName;
                                        
                                        // Очищаем текущие элементы меню
                                        this.historySection._getMenuItems().forEach(item => item.destroy());
                                        this.favoritesSection._getMenuItems().forEach(item => item.destroy());
                                        this.clipItemsRadioGroup = [];
                                        
                                        // Загружаем данные переименованного workspace
                                        const clipHistory = await this._getCache();
                                        clipHistory.forEach(entry => this._addEntry(entry));
                                        if (clipHistory.length > 0) {
                                            this._selectMenuItem(this.clipItemsRadioGroup[clipHistory.length - 1]);
                                        }
                                    }
                                    
                                    // Сохраняем конфигурацию
                                    this._saveWorkspacesConfig();
                                    
                                    // Обновляем label
                                    label.set_text(newName);
                                } else {
                                    // Если произошла ошибка при переименовании, показываем уведомление
                                    this._showNotification(_("Failed to rename workspace"));
                                }
                            }
                        }
                        
                        // Возвращаем label и кнопки обратно
                        buttonContent.remove_child(entry);
                        buttonContent.insert_child_at_index(label, 0);
                        editButton.show();
                        deleteButton.show();
                    });
                    
                    // Обработчик отмены редактирования (Esc)
                    entry.clutter_text.connect('key-press-event', (actor, event) => {
                        if (event.get_key_symbol() === Clutter.KEY_Escape) {
                            buttonContent.remove_child(entry);
                            buttonContent.insert_child_at_index(label, 0);
                            editButton.show();
                            deleteButton.show();
                            return Clutter.EVENT_STOP;
                        }
                        return Clutter.EVENT_PROPAGATE;
                    });
                });
                
                // Добавляем обработчик клика для кнопки workspace
                button.connect('clicked', () => {
                    // Получаем актуальное имя из текста label
                    const currentName = label.get_text();
                    this._switchWorkspace(currentName);
                    workspaceButtonsBox.get_children().forEach(child => {
                        child.remove_style_pseudo_class('active');
                    });
                    button.add_style_pseudo_class('active');
                });
                
                // Если это активный workspace, выделяем его
                if (workspaceName === this.activeWorkspace) {
                    button.add_style_pseudo_class('active');
                }
                
                deleteButton.connect('clicked', () => {
                    if (this.workspaces.length > 1) {
                        // Получаем актуальное имя из текста label
                        const currentName = label.get_text();
                        const idx = this.workspaces.indexOf(currentName);
                        this.workspaces.splice(idx, 1);
                        workspaceButtonsBox.remove_child(button);
                        
                        // Очищаем данные удаляемого workspace
                        this.registry.clearWorkspace(currentName);
                        
                        // Если удаляем активный workspace, переключимся на другой
                        if (this.activeWorkspace === currentName) {
                            this._switchWorkspace(this.workspaces[0]);
                        }
                        
                        // Сохраняем конфигурацию
                        this._saveWorkspacesConfig();
                    }
                });
                
                workspaceButtonsBox.add_child(button);
            }
            
            // Add "+" button
            const addIcon = new St.Icon({
                icon_name: 'list-add-symbolic',
                style_class: 'workspace-add-icon',
                icon_size: 16
            });
            
            const addButton = new St.Button({
                style_class: 'workspace-add-button',
                child: addIcon
            });
            
            addButton.connect('clicked', () => {
                // Create new workspace button with entry
                const buttonContent = new St.BoxLayout({
                    style_class: 'workspace-button-content'
                });
                
                const entry = new St.Entry({
                    style_class: 'workspace-name-entry',
                    hint_text: 'Enter name...',
                    can_focus: true
                });
                
                const deleteIcon = new St.Icon({
                    icon_name: 'window-close-symbolic',
                    style_class: 'workspace-delete-icon',
                    icon_size: 14
                });
                
                const deleteButton = new St.Button({
                    style_class: 'workspace-delete-button',
                    child: deleteIcon
                });
                
                const button = new St.Button({
                    style_class: 'workspace-button',
                    x_expand: true
                });
                
                buttonContent.add_child(entry);
                buttonContent.add_child(deleteButton);
                button.set_child(buttonContent);
                
                deleteButton.connect('clicked', () => {
                    workspaceButtonsBox.remove_child(button);
                });
                
                entry.clutter_text.connect('activate', () => {
                    const name = entry.get_text();
                    if (name) {
                        buttonContent.remove_child(entry);
                        const label = new St.Label({
                            text: name,
                            y_align: Clutter.ActorAlign.CENTER
                        });
                        buttonContent.insert_child_at_index(label, 0);
                        
                        // Добавляем новый workspace в писок
                        this.workspaces.push(name);
                        
                        // Добавляем обработчик клика
                        button.connect('clicked', () => {
                            this._switchWorkspace(name);
                            // Добавим визуальное выделение активного workspace
                            workspaceButtonsBox.get_children().forEach(child => {
                                child.remove_style_pseudo_class('active');
                            });
                            button.add_style_pseudo_class('active');
                        });
                        
                        // Сохраняем конфигурацию
                        this._saveWorkspacesConfig();
                        
                        // Автоматически переключаемся на новый workspace
                        this._switchWorkspace(name);
                        workspaceButtonsBox.get_children().forEach(child => {
                            child.remove_style_pseudo_class('active');
                        });
                        button.add_style_pseudo_class('active');
                    }
                });
                
                // Вствляем новую кнопку перед кнопкой добавления
                const addButtonIndex = workspaceButtonsBox.get_children().indexOf(addButton);
                workspaceButtonsBox.insert_child_at_index(button, addButtonIndex);
                
                global.stage.set_key_focus(entry);
            });
            
            workspaceButtonsBox.add_child(addButton);
            
            this.menu.box.add_child(workspaceButtonsBox);

            // Create menu sections for items
            // Favorites
            that.favoritesSection = new PopupMenu.PopupMenuSection();

            that.scrollViewFavoritesMenuSection = new PopupMenu.PopupMenuSection();
            this.favoritesScrollView = new St.ScrollView({
                style_class: 'ci-history-menu-section',
                overlay_scrollbars: true
            });
            this.favoritesScrollView.add_child(that.favoritesSection.actor);

            that.scrollViewFavoritesMenuSection.actor.add_child(this.favoritesScrollView);
            this.favoritesSeparator = new PopupMenu.PopupSeparatorMenuItem();

            // History
            that.historySection = new PopupMenu.PopupMenuSection();

            that.scrollViewMenuSection = new PopupMenu.PopupMenuSection();
            this.historyScrollView = new St.ScrollView({
                style_class: 'ci-main-menu-section ci-history-menu-section',
                overlay_scrollbars: true
            });
            this.historyScrollView.add_child(that.historySection.actor);

            that.scrollViewMenuSection.actor.add_child(this.historyScrollView);

            // Add separator
            this.historySeparator = new PopupMenu.PopupSeparatorMenuItem();

            // Add sections ordered according to settings
            if (PINNED_ON_BOTTOM) {
                that.menu.addMenuItem(that.scrollViewMenuSection);
                that.menu.addMenuItem(that.scrollViewFavoritesMenuSection);
            }
            else {
                that.menu.addMenuItem(that.scrollViewFavoritesMenuSection);
                that.menu.addMenuItem(that.scrollViewMenuSection);
            }

            // Private mode switch
            that.privateModeMenuItem = new PopupMenu.PopupSwitchMenuItem(
                _("Private mode"), PRIVATEMODE, { reactive: true });
            that.privateModeMenuItem.connect('toggled',
                that._onPrivateModeSwitch.bind(that));
            that.privateModeMenuItem.insert_child_at_index(
                new St.Icon({
                    icon_name: 'security-medium-symbolic',
                    style_class: 'clipboard-menu-icon',
                    y_align: Clutter.ActorAlign.CENTER
                }),
                0
            );
            that.menu.addMenuItem(that.privateModeMenuItem);

            // Add 'Clear' button which removes all items from cache
            this.clearMenuItem = new PopupMenu.PopupMenuItem(_('Clear history'));
            this.clearMenuItem.insert_child_at_index(
                new St.Icon({
                    icon_name: 'user-trash-symbolic',
                    style_class: 'clipboard-menu-icon',
                    y_align: Clutter.ActorAlign.CENTER
                }),
                0
            );
            this.clearMenuItem.connect('activate', that._removeAll.bind(that));

            // Add 'Settings' menu item to open settings
            this.settingsMenuItem = new PopupMenu.PopupMenuItem(_('Settings'));
            this.settingsMenuItem.insert_child_at_index(
                new St.Icon({
                    icon_name: 'preferences-system-symbolic',
                    style_class: 'clipboard-menu-icon',
                    y_align: Clutter.ActorAlign.CENTER
                }),
                0
            );
            that.menu.addMenuItem(this.settingsMenuItem);
            this.settingsMenuItem.connect('activate', that._openSettings.bind(that));

            // Empty state section
            this.emptyStateSection = new St.BoxLayout({
                style_class: 'clipboard-indicator-empty-state',
                vertical: true
            });
            this.emptyStateSection.add_child(new St.Icon({
                icon_name: INDICATOR_ICON,
                style_class: 'system-status-icon clipboard-indicator-icon',
                x_align: Clutter.ActorAlign.CENTER
            }));
            this.emptyStateSection.add_child(new St.Label({
                text: _('Clipboard is empty'),
                x_align: Clutter.ActorAlign.CENTER
            }));

            // Add cached items
            clipHistory.forEach(entry => this._addEntry(entry));

            if (lastIdx >= 0) {
                that._selectMenuItem(clipItemsArr[lastIdx]);
            }

            this.#showElements();
        } catch (e) {
            console.error('Failed to build menu:', e);
        }
    }

    #hideElements() {
        if (this.menu.box.contains(this._entryItem)) this.menu.box.remove_child(this._entryItem);
        if (this.menu.box.contains(this.favoritesSeparator)) this.menu.box.remove_child(this.favoritesSeparator);
        if (this.menu.box.contains(this.historySeparator)) this.menu.box.remove_child(this.historySeparator);
        if (this.menu.box.contains(this.clearMenuItem)) this.menu.box.remove_child(this.clearMenuItem);
        if (this.menu.box.contains(this.emptyStateSection)) this.menu.box.remove_child(this.emptyStateSection);
    }

    #showElements() {
        if (this.clipItemsRadioGroup.length > 0) {
            if (this.menu.box.contains(this._entryItem) === false) {
                this.menu.box.insert_child_at_index(this._entryItem, 0);
            }
            if (this.menu.box.contains(this.clearMenuItem) === false) {
                this.menu.box.insert_child_below(this.clearMenuItem, this.settingsMenuItem);
            }
            if (this.menu.box.contains(this.emptyStateSection) === true) {
                this.menu.box.remove_child(this.emptyStateSection);
            }

            if (this.favoritesSection._getMenuItems().length > 0) {
                if (this.menu.box.contains(this.favoritesSeparator) === false) {
                    this.menu.box.insert_child_above(this.favoritesSeparator, this.scrollViewFavoritesMenuSection.actor);
                }
            }
            else if (this.menu.box.contains(this.favoritesSeparator) === true) {
                this.menu.box.remove_child(this.favoritesSeparator);
            }

            if (this.historySection._getMenuItems().length > 0) {
                if (this.menu.box.contains(this.historySeparator) === false) {
                    this.menu.box.insert_child_above(this.historySeparator, this.scrollViewMenuSection.actor);
                }
            }
            else if (this.menu.box.contains(this.historySeparator) === true) {
                this.menu.box.remove_child(this.historySeparator);
            }
        }
        else if (this.menu.box.contains(this.emptyStateSection) === false) {
            this.#renderEmptyState();
        }
    }

    #renderEmptyState () {
        this.#hideElements();
        this.menu.box.insert_child_at_index(this.emptyStateSection, 0);
    }

    /* When text change, this function will check, for each item of the
    historySection and favoritesSestion, if it should be visible or not (based on words contained
    in the clipContents attribute of the item). It doesn't destroy or create
    items. It the entry is empty, the section is restored with all items
    set as visible. */
    _onSearchTextChanged () {
        let searchedText = this.searchEntry.get_text().toLowerCase();

        if(searchedText === '') {
            this._getAllIMenuItems().forEach(function(mItem){
                mItem.actor.visible = true;
            });
        }
        else {
            this._getAllIMenuItems().forEach(function(mItem){
                let text = mItem.clipContents.toLowerCase();
                let isMatching = text.indexOf(searchedText) >= 0;
                mItem.actor.visible = isMatching
            });
        }
    }

    _truncate (string, length) {
        let shortened = string.replace(/\s+/g, ' ');

        let chars = [...shortened]
        if (chars.length > length)
            shortened = chars.slice(0, length - 1).join('') + '...';

        return shortened;
    }

    _setEntryLabel (menuItem) {
        const { entry } = menuItem;
        if (entry.isText()) {
            menuItem.label.set_text(this._truncate(entry.getStringValue(), MAX_ENTRY_LENGTH));
        }
        else if (entry.isImage()) {
            menuItem.label.set_text('[Image]');
            this.registry.getEntryAsImage(entry, this.activeWorkspace).then(img => {
                if (img) {
                    img.add_style_class_name('clipboard-menu-img-preview');
                    if (menuItem.previewImage) {
                        menuItem.remove_child(menuItem.previewImage);
                    }
                    menuItem.previewImage = img;
                    menuItem.insert_child_below(img, menuItem.label);
                }
            });
        }
    }

    _findNextMenuItem (currentMenutItem) {
        let currentIndex = this.clipItemsRadioGroup.indexOf(currentMenutItem);

        // for only one item
        if(this.clipItemsRadioGroup.length === 1) {
            return null;
        }

        // when focus is in middle of the displayed list
        for (let i = currentIndex - 1; i >= 0; i--) {
            let menuItem = this.clipItemsRadioGroup[i];
            if (menuItem.actor.visible) {
                return menuItem;
            }
        }

        // when focus is at the last element of the displayed list
        let beforeMenuItem = this.clipItemsRadioGroup[currentIndex + 1];
        if(beforeMenuItem.actor.visible){
          return beforeMenuItem; 
        }

        return null;
    }

    #selectNextMenuItem (menuItem) {
        let nextMenuItem = this._findNextMenuItem(menuItem);

        if (nextMenuItem) {
            nextMenuItem.actor.grab_key_focus();
        } else {
            this.privateModeMenuItem.actor.grab_key_focus();
        }
    }

    _addEntry (entry, autoSelect, autoSetClip) {
        let menuItem = new PopupMenu.PopupMenuItem('');

        menuItem.menu = this.menu;
        menuItem.entry = entry;
        menuItem.clipContents = entry.getStringValue();
        menuItem.radioGroup = this.clipItemsRadioGroup;
        const allowedKeysyms = [
            Clutter.KEY_KP_Enter,
            Clutter.KEY_Return,
          ];
        menuItem.keyPressId = menuItem.connect('key-press-event', (actor, event) => {
            if (allowedKeysyms.includes(event.get_key_symbol())) {
                this._onMenuItemSelectedAndMenuClose(menuItem, 'activate')
                return true;
            }
            return false;
        })
        menuItem.buttonPressId = menuItem.connect('activate',
            autoSet => this._onMenuItemSelectedAndMenuClose(menuItem, autoSet));
        menuItem.connect('key-focus-in', () => {
            const viewToScroll = menuItem.entry.isFavorite() ?
                this.favoritesScrollView : this.historyScrollView;
            AnimationUtils.ensureActorVisibleInScrollView(viewToScroll, menuItem);
        });
        menuItem.actor.connect('key-press-event', (actor, event) => {
            if(event.get_key_symbol() === Clutter.KEY_Delete) {
                this.#selectNextMenuItem(menuItem);
                this._removeEntry(menuItem, 'delete');
            }
            else if (event.get_key_symbol() === Clutter.KEY_p) {
                this.#selectNextMenuItem(menuItem);
                this._favoriteToggle(menuItem);
            }
            else if (event.get_key_symbol() === Clutter.KEY_v) {
                this.#pasteItem(menuItem);
            }
        })

        this._setEntryLabel(menuItem);
        this.clipItemsRadioGroup.push(menuItem);

        // Favorite button
        let iconfav = new St.Icon({
            icon_name: 'view-pin-symbolic',
            style_class: 'system-status-icon'
        });

        let icofavBtn = new St.Button({
            style_class: 'ci-pin-btn ci-action-btn',
            can_focus: true,
            child: iconfav,
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true
        });

        menuItem.actor.add_child(icofavBtn);
        menuItem.icofavBtn = icofavBtn;
        menuItem.favoritePressId = icofavBtn.connect('clicked',
            () => this._favoriteToggle(menuItem)
        );

        // Paste button
        menuItem.pasteBtn = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            child: new St.Icon({
                icon_name: 'edit-paste-symbolic',
                style_class: 'system-status-icon'
            }),
            x_align: Clutter.ActorAlign.END,
            x_expand: false,
            y_expand: true,
            visible: PASTE_BUTTON
        });

        menuItem.pasteBtn.connect('clicked',
            () => this.#pasteItem(menuItem)
        );

        menuItem.actor.add_child(menuItem.pasteBtn);

        // Delete button
        let icon = new St.Icon({
            icon_name: 'edit-delete-symbolic', //'mail-attachment-symbolic',
            style_class: 'system-status-icon'
        });

        let icoBtn = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            child: icon,
            x_align: Clutter.ActorAlign.END,
            x_expand: false,
            y_expand: true
        });

        menuItem.actor.add_child(icoBtn);
        menuItem.icoBtn = icoBtn;
        menuItem.deletePressId = icoBtn.connect('clicked',
            () => this._removeEntry(menuItem, 'delete')
        );

        if (entry.isFavorite()) {
            this.favoritesSection.addMenuItem(menuItem, 0);
        } else {
            this.historySection.addMenuItem(menuItem, 0);
        }

        if (autoSelect === true) {
            this._selectMenuItem(menuItem, autoSetClip);
        }
        else {
            menuItem.setOrnament(PopupMenu.Ornament.NONE);
        }

        this.#showElements();
    }

    _favoriteToggle (menuItem) {
        menuItem.entry.favorite = menuItem.entry.isFavorite() ? false : true;
        this._moveItemFirst(menuItem);
        this._updateCache();
        this.#showElements();
    }

    _confirmRemoveAll () {
        const title = _("Clear all?");
        const message = _("Are you sure you want to delete all clipboard items?");
        const sub_message = _("This operation cannot be undone.");

        this.dialogManager.open(title, message, sub_message, _("Clear"), _("Cancel"), () => {
            this._clearHistory();
        }
      );
    }

    _clearHistory () {
        // Don't remove pinned items
        this.historySection._getMenuItems().forEach(mItem => {
            if (KEEP_SELECTED_ON_CLEAR === false || !mItem.currentlySelected) {
                this._removeEntry(mItem, 'delete');
            }
        });
        this._showNotification(_("Clipboard history cleared"));
    }

    _removeAll () {
        if (PRIVATEMODE) return;
        var that = this;

        if (CONFIRM_ON_CLEAR) {
            that._confirmRemoveAll();
        } else {
            that._clearHistory();
        }
    }

    _removeEntry (menuItem, event) {
        let itemIdx = this.clipItemsRadioGroup.indexOf(menuItem);

        if(event === 'delete' && menuItem.currentlySelected) {
            this.#clearClipboard();
        }

        menuItem.destroy();
        this.clipItemsRadioGroup.splice(itemIdx,1);

        if (menuItem.entry.isImage()) {
            this.registry.deleteEntryFile(menuItem.entry, this.activeWorkspace);
        }

        this._updateCache();
        this.#showElements();
    }

    _removeOldestEntries () {
        let that = this;

        // Если MAX_REGISTRY_LENGTH равен 0, не удаляем старые записи
        if (MAX_REGISTRY_LENGTH === 0) return;

        let clipItemsRadioGroupNoFavorite = that.clipItemsRadioGroup.filter(
            item => item.entry.isFavorite() === false);

        const origSize = clipItemsRadioGroupNoFavorite.length;

        while (clipItemsRadioGroupNoFavorite.length > MAX_REGISTRY_LENGTH) {
            let oldestNoFavorite = clipItemsRadioGroupNoFavorite.shift();
            that._removeEntry(oldestNoFavorite);

            clipItemsRadioGroupNoFavorite = that.clipItemsRadioGroup.filter(
                item => item.entry.isFavorite() === false);
        }

        if (clipItemsRadioGroupNoFavorite.length < origSize) {
            that._updateCache();
        }
    }

    _onMenuItemSelected (menuItem, autoSet) {
        for (let otherMenuItem of menuItem.radioGroup) {
            let clipContents = menuItem.clipContents;

            if (otherMenuItem === menuItem && clipContents) {
                menuItem.setOrnament(PopupMenu.Ornament.DOT);
                menuItem.currentlySelected = true;
                if (autoSet !== false)
                    this.#updateClipboard(menuItem.entry);
            }
            else {
                otherMenuItem.setOrnament(PopupMenu.Ornament.NONE);
                otherMenuItem.currentlySelected = false;
            }
        }
    }

    _selectMenuItem (menuItem, autoSet) {
        this._onMenuItemSelected(menuItem, autoSet);
        this.#updateIndicatorContent(menuItem.entry);
    }

    _onMenuItemSelectedAndMenuClose (menuItem, autoSet) {
        for (let otherMenuItem of menuItem.radioGroup) {
            let clipContents = menuItem.clipContents;

            if (menuItem === otherMenuItem && clipContents) {
                menuItem.setOrnament(PopupMenu.Ornament.DOT);
                menuItem.currentlySelected = true;
                if (autoSet !== false)
                    this.#updateClipboard(menuItem.entry);
            }
            else {
                otherMenuItem.setOrnament(PopupMenu.Ornament.NONE);
                otherMenuItem.currentlySelected = false;
            }
        }

        menuItem.menu.close();
    }

    _getCache () {
        return this.registry.read(this.activeWorkspace);
    }

    _updateCache () {
        const entries = this.clipItemsRadioGroup
            .map(menuItem => menuItem.entry)
            .filter(entry => CACHE_ONLY_FAVORITE == false || entry.isFavorite());

        this.registry.write(entries, this.activeWorkspace);
    }

    #addToCache (entry) {
        const entries = this.clipItemsRadioGroup
            .map(menuItem => menuItem.entry)
            .filter(entry => CACHE_ONLY_FAVORITE == false || entry.isFavorite())
            .concat([entry]);
        this.registry.write(entries, this.activeWorkspace);
    }

    async _onSelectionChange (selection, selectionType, selectionSource) {
        if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
            this._refreshIndicator();
        }
    }

    async _refreshIndicator () {
        if (PRIVATEMODE) return; // Private mode, do not.
        if (this.#refreshInProgress) return;
        this.#refreshInProgress = true;

        try {
            const result = await this.#getClipboardContent();

            if (result) {
                // Проверяем, есть ли такой элемент уже в списке
                let existingItem = null;
                for (let menuItem of this.clipItemsRadioGroup) {
                    if (menuItem.entry.equals(result)) {
                        existingItem = menuItem;
                        break;
                    }
                }

                if (existingItem) {
                    this._selectMenuItem(existingItem, false);
                    if (!existingItem.entry.isFavorite() && MOVE_ITEM_FIRST) {
                        this._moveItemFirst(existingItem);
                    }
                } else {
                    // Проверяем лимит только если MAX_REGISTRY_LENGTH не равен 0
                    if (MAX_REGISTRY_LENGTH === 0 || 
                        this.clipItemsRadioGroup.filter(item => !item.entry.isFavorite()).length < MAX_REGISTRY_LENGTH) {
                        this.#addToCache(result);
                        this._addEntry(result, true, false);
                    } else {
                        // Если достигнут лимит, удаляем самый старый не избранный элемент
                        this._removeOldestEntries();
                        this.#addToCache(result);
                        this._addEntry(result, true, false);
                    }

                    if (NOTIFY_ON_COPY) {
                        this._showNotification(_("Copied to clipboard"), notif => {
                            notif.addAction(_('Cancel'), this._cancelNotification);
                        });
                    }
                }
            }
        } catch (e) {
            console.error('Failed to refresh indicator:', e);
        } finally {
            this.#refreshInProgress = false;
        }
    }

    _moveItemFirst (item) {
        this._removeEntry(item);
        this._addEntry(item.entry, item.currentlySelected, false);
        this._updateCache();
    }

    _findItem (text) {
        return this.clipItemsRadioGroup.filter(
            item => item.clipContents === text)[0];
    }

    _getCurrentlySelectedItem () {
        return this.clipItemsRadioGroup.find(item => item.currentlySelected);
    }

    _getAllIMenuItems () {
        return this.historySection._getMenuItems().concat(this.favoritesSection._getMenuItems());
    }

    _setupListener () {
        const metaDisplay = Shell.Global.get().get_display();
        const selection = metaDisplay.get_selection();
        this._setupSelectionTracking(selection);
    }

    _setupSelectionTracking (selection) {
        this.selection = selection;
        this._selectionOwnerChangedId = selection.connect('owner-changed', (selection, selectionType, selectionSource) => {
            this._onSelectionChange(selection, selectionType, selectionSource);
        });
    }

    _openSettings () {
        this.extension.openSettings();
    }

    _initNotifSource () {
        if (!this._notifSource) {
            this._notifSource = new MessageTray.Source({
                title: 'Clipboard Indicator',
                'icon-name': INDICATOR_ICON
            });

            this._notifSource.connect('destroy', () => {
                this._notifSource = null;
            });

            Main.messageTray.add(this._notifSource);
        }
    }

    _cancelNotification () {
        if (this.clipItemsRadioGroup.length >= 2) {
            let clipSecond = this.clipItemsRadioGroup.length - 2;
            let previousClip = this.clipItemsRadioGroup[clipSecond];
            this.#updateClipboard(previousClip.entry);
            previousClip.setOrnament(PopupMenu.Ornament.DOT);
            previousClip.icoBtn.visible = false;
            previousClip.currentlySelected = true;
        } else {
            this.#clearClipboard();
        }
        let clipFirst = this.clipItemsRadioGroup.length - 1;
        this._removeEntry(this.clipItemsRadioGroup[clipFirst]);
    }

    _showNotification (message, transformFn) {
        const dndOn = () =>
            !Main.panel.statusArea.dateMenu._indicator._settings.get_boolean(
                'show-banners',
            );
        if (PRIVATEMODE || dndOn()) {
            return;
        }

        let notification = null;

        this._initNotifSource();

        if (this._notifSource.count === 0) {
            notification = new MessageTray.Notification({
                source: this._notifSource,
                body: message,
                'is-transient': true
            });
        }
        else {
            notification = this._notifSource.notifications[0];
            notification.body = message;
            notification.clearActions();
        }

        if (typeof transformFn === 'function') {
            transformFn(notification);
        }

        this._notifSource.addNotification(notification);
    }

    _createHistoryLabel () {
        this._historyLabel = new St.Label({
            style_class: 'ci-notification-label',
            text: ''
        });

        global.stage.add_child(this._historyLabel);

        this._historyLabel.hide();
    }

    togglePrivateMode () {
        this.privateModeMenuItem.toggle();
    }

    _onPrivateModeSwitch () {
        let that = this;
        PRIVATEMODE = this.privateModeMenuItem.state;
        // We hide the history in private ModeTypee because it will be out of sync (selected item will not reflect clipboard)
        this.scrollViewMenuSection.actor.visible = !PRIVATEMODE;
        this.scrollViewFavoritesMenuSection.actor.visible = !PRIVATEMODE;
        // If we get out of private mode then we restore the clipboard to old state
        if (!PRIVATEMODE) {
            let selectList = this.clipItemsRadioGroup.filter((item) => !!item.currentlySelected);

            if (selectList.length) {
                this._selectMenuItem(selectList[0]);
            } else {
                // Nothing to return to, let's empty it instead
                this.#clearClipboard();
            }

            this.#getClipboardContent().then(entry => {
                if (!entry) return;
                this.#updateIndicatorContent(entry);
            }).catch(e => console.error(e));

            this.hbox.remove_style_class_name('private-mode');
            this.#showElements();
        } else {
            this.hbox.add_style_class_name('private-mode');
            this.#updateIndicatorContent(null);
            this.#hideElements();
        }
    }

    _loadSettings () {
        this._settingsChangedId = this.extension.settings.connect('changed',
            this._onSettingsChange.bind(this));

        this._fetchSettings();

        if (ENABLE_KEYBINDING) {
            this._bindShortcuts();
        }
    }

    _fetchSettings () {
        const { settings } = this.extension;
        MAX_REGISTRY_LENGTH    = settings.get_int(PrefsFields.HISTORY_SIZE);
        MAX_ENTRY_LENGTH       = settings.get_int(PrefsFields.PREVIEW_SIZE);
        CACHE_ONLY_FAVORITE    = settings.get_boolean(PrefsFields.CACHE_ONLY_FAVORITE);
        DELETE_ENABLED         = settings.get_boolean(PrefsFields.DELETE);
        MOVE_ITEM_FIRST        = settings.get_boolean(PrefsFields.MOVE_ITEM_FIRST);
        NOTIFY_ON_COPY         = settings.get_boolean(PrefsFields.NOTIFY_ON_COPY);
        CONFIRM_ON_CLEAR       = settings.get_boolean(PrefsFields.CONFIRM_ON_CLEAR);
        ENABLE_KEYBINDING      = settings.get_boolean(PrefsFields.ENABLE_KEYBINDING);
        MAX_TOPBAR_LENGTH      = settings.get_int(PrefsFields.TOPBAR_PREVIEW_SIZE);
        TOPBAR_DISPLAY_MODE    = settings.get_int(PrefsFields.TOPBAR_DISPLAY_MODE_ID);
        CLEAR_ON_BOOT          = settings.get_boolean(PrefsFields.CLEAR_ON_BOOT);
        DISABLE_DOWN_ARROW     = settings.get_boolean(PrefsFields.DISABLE_DOWN_ARROW);
        STRIP_TEXT             = settings.get_boolean(PrefsFields.STRIP_TEXT);
        KEEP_SELECTED_ON_CLEAR = settings.get_boolean(PrefsFields.KEEP_SELECTED_ON_CLEAR);
        PASTE_BUTTON           = settings.get_boolean(PrefsFields.PASTE_BUTTON);
        PINNED_ON_BOTTOM       = settings.get_boolean(PrefsFields.PINNED_ON_BOTTOM);

    }

    async _onSettingsChange () {
        try {
            var that = this;

            // Load the settings into variables
            that._fetchSettings();

            // Remove old entries in case the registry size changed
            that._removeOldestEntries();

            // Re-set menu-items lables in case preview size changed
            this._getAllIMenuItems().forEach(function (mItem) {
                that._setEntryLabel(mItem);
                mItem.pasteBtn.visible = PASTE_BUTTON;
            });

            //update topbar
            this._updateTopbarLayout();
            that.#updateIndicatorContent(await this.#getClipboardContent());

            // Bind or unbind shortcuts
            if (ENABLE_KEYBINDING)
                that._bindShortcuts();
            else
                that._unbindShortcuts();
        } catch (e) {
            console.error('Clipboard Indicator: Failed to update registry');
            console.error(e);
        }
    }

    _bindShortcuts () {
        this._unbindShortcuts();
        this._bindShortcut(PrefsFields.BINDING_CLEAR_HISTORY, this._removeAll);
        this._bindShortcut(PrefsFields.BINDING_PREV_ENTRY, this._previousEntry);
        this._bindShortcut(PrefsFields.BINDING_NEXT_ENTRY, this._nextEntry);
        this._bindShortcut(PrefsFields.BINDING_TOGGLE_MENU, this._toggleMenu);
        this._bindShortcut(PrefsFields.BINDING_PRIVATE_MODE, this.togglePrivateMode);
    }

    _unbindShortcuts () {
        this._shortcutsBindingIds.forEach(
            (id) => Main.wm.removeKeybinding(id)
        );

        this._shortcutsBindingIds = [];
    }

    _bindShortcut (name, cb) {
        var ModeType = Shell.hasOwnProperty('ActionMode') ?
            Shell.ActionMode : Shell.KeyBindingMode;

        Main.wm.addKeybinding(
            name,
            this.extension.settings,
            Meta.KeyBindingFlags.NONE,
            ModeType.ALL,
            cb.bind(this)
        );

        this._shortcutsBindingIds.push(name);
    }

    _updateTopbarLayout () {
        if(TOPBAR_DISPLAY_MODE === 0){
            this.icon.visible = true;
            this._buttonText.visible = false;
            this.show();
        }
        if(TOPBAR_DISPLAY_MODE === 1){
            this.icon.visible = false;
            this._buttonText.visible = true;
            this.show();
        }
        if(TOPBAR_DISPLAY_MODE === 2){
            this.icon.visible = true;
            this._buttonText.visible = true;
            this.show();
        }
        if (TOPBAR_DISPLAY_MODE === 3) {
            this.hide();
        }
        if(!DISABLE_DOWN_ARROW) {
            this._downArrow.visible = true;
        } else {
            this._downArrow.visible = false;
        }
    }

    _disconnectSettings () {
        if (!this._settingsChangedId)
            return;

        this.extension.settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = null;
    }

    _disconnectSelectionListener () {
        if (!this._selectionOwnerChangedId)
            return;

        this.selection.disconnect(this._selectionOwnerChangedId);
    }

    _clearDelayedSelectionTimeout () {
        if (this._delayedSelectionTimeoutId) {
            clearInterval(this._delayedSelectionTimeoutId);
        }
    }

    _selectEntryWithDelay (entry) {
        let that = this;
        that._selectMenuItem(entry, false);

        that._delayedSelectionTimeoutId = setTimeout(function () {
            that._selectMenuItem(entry);  //select the item
            that._delayedSelectionTimeoutId = null;
        }, DELAYED_SELECTION_TIMEOUT);
    }

    _previousEntry () {
        if (PRIVATEMODE) return;
        let that = this;

        that._clearDelayedSelectionTimeout();

        this._getAllIMenuItems().some(function (mItem, i, menuItems){
            if (mItem.currentlySelected) {
                i--;                                 //get the previous index
                if (i < 0) i = menuItems.length - 1; //cycle if out of bound
                let index = i + 1;                   //index to be displayed
                that._showNotification(index + ' / ' + menuItems.length + ': ' + menuItems[i].entry.getStringValue());
                if (MOVE_ITEM_FIRST) {
                    that._selectEntryWithDelay(menuItems[i]);
                }
                else {
                    that._selectMenuItem(menuItems[i]);
                }
                return true;
            }
            return false;
        });
    }

    _nextEntry () {
        if (PRIVATEMODE) return;
        let that = this;

        that._clearDelayedSelectionTimeout();

        this._getAllIMenuItems().some(function (mItem, i, menuItems){
            if (mItem.currentlySelected) {
                i++;                                 //get the next index
                if (i === menuItems.length) i = 0;   //cycle if out of bound
                let index = i + 1;                     //index to be displayed
                that._showNotification(index + ' / ' + menuItems.length + ': ' + menuItems[i].entry.getStringValue());
                if (MOVE_ITEM_FIRST) {
                    that._selectEntryWithDelay(menuItems[i]);
                }
                else {
                    that._selectMenuItem(menuItems[i]);
                }
                return true;
            }
            return false;
        });
    }

    _toggleMenu () {
        if (this.menu.isOpen) {
            this.menu.close();
            if (this._keyPressEventId) {
                global.stage.disconnect(this._keyPressEventId);
                this._keyPressEventId = null;
            }
        } else {
            this.menu.open();
            this._keyPressEventId = global.stage.connect('key-press-event', (actor, event) => {
                const symbol = event.get_key_symbol();
                const modifiers = event.get_state();
                const controlPressed = (modifiers & Clutter.ModifierType.CONTROL_MASK) !== 0;

                if (controlPressed) {
                    switch (symbol) {
                        case Clutter.KEY_bracketleft:  // Ctrl + [
                            this._switchToPreviousWorkspace();
                            return Clutter.EVENT_STOP;
                        case Clutter.KEY_bracketright: // Ctrl + ]
                            this._switchToNextWorkspace();
                            return Clutter.EVENT_STOP;
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }
    }

    #pasteItem (menuItem) {
        this.menu.close();
        const currentlySelected = this._getCurrentlySelectedItem();
        this.preventIndicatorUpdate = true;
        this.#updateClipboard(menuItem.entry);
        this._pastingKeypressTimeout = setTimeout(() => {
            if (this.keyboard.purpose === Clutter.InputContentPurpose.TERMINAL) {
                this.keyboard.press(Clutter.KEY_Control_L);
                this.keyboard.press(Clutter.KEY_Shift_L);
                this.keyboard.press(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Shift_L);
                this.keyboard.release(Clutter.KEY_Control_L);
            }
            else {
                this.keyboard.press(Clutter.KEY_Shift_L);
                this.keyboard.press(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Shift_L);
            }

            this._pastingResetTimeout = setTimeout(() => {
                this.preventIndicatorUpdate = false;
                this.#updateClipboard(currentlySelected.entry);
            }, 50);
        }, 50);
    }

    #clearTimeouts () {
        if (this._imagePreviewTimeout) clearTimeout(this._imagePreviewTimeout);
        if (this._setFocusOnOpenTimeout) clearTimeout(this._setFocusOnOpenTimeout);
        if (this._pastingKeypressTimeout) clearTimeout(this._pastingKeypressTimeout);
        if (this._pastingResetTimeout) clearTimeout(this._pastingResetTimeout);
    }

    #clearClipboard () {
        this.extension.clipboard.set_text(CLIPBOARD_TYPE, "");
        this.#updateIndicatorContent(null);
    }

    #updateClipboard (entry) {
        this.extension.clipboard.set_content(CLIPBOARD_TYPE, entry.mimetype(), entry.asBytes());
        this.#updateIndicatorContent(entry);
    }

    async #getClipboardContent () {
        try {
            const mimetypes = [
                "text/plain;charset=utf-8",
                "UTF8_STRING",
                "text/plain",
                "STRING",
                'image/gif',
                'image/png',
                'image/jpg',
                'image/jpeg',
                'image/webp',
                'image/svg+xml',
                'text/html',
            ];

            for (let type of mimetypes) {
                try {
                    let result = await new Promise((resolve, reject) => {
                        this.extension.clipboard.get_content(CLIPBOARD_TYPE, type, (clipBoard, bytes) => {
                            try {
                                if (bytes === null || bytes.get_size() === 0) {
                                    resolve(null);
                                    return;
                                }

                                const entry = new ClipboardEntry(type, bytes.get_data(), false);
                                if (entry.isImage()) {
                                    this.registry.writeEntryFile(entry, this.activeWorkspace);
                                }
                                resolve(entry);
                            } catch (e) {
                                reject(e);
                            }
                        });
                    });

                    if (result) return result;
                } catch (e) {
                    console.error(`Failed to get clipboard content for type ${type}:`, e);
                    continue;
                }
            }

            return null;
        } catch (e) {
            console.error('Failed to get clipboard content:', e);
            return null;
        }
    }

    async _switchWorkspace(name) {
        try {
            // Проверяем существование workspace в списке
            if (!this.workspaces.includes(name)) {
                console.error('Workspace not found:', name);
                // Если workspace не существует, переключаемся на первый доступный
                name = this.workspaces[0];
            }

            // Сохраняем текущее состояние перед переключением
            this._updateCache();
            
            // Очищаем текущие элементы меню
            this.historySection._getMenuItems().forEach(item => item.destroy());
            this.favoritesSection._getMenuItems().forEach(item => item.destroy());
            this.clipItemsRadioGroup = [];
            
            // Добавляем задержку, чтобы дать время на завершение операций с файлами
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Переключим активный workspace
            this.activeWorkspace = name;
            
            // Сохраняем конфигурацию
            this._saveWorkspacesConfig();
            
            // Добавляем еще одну задержку перед загрузкой данных
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Загружаем данные нового workspace
            const clipHistory = await this._getCache();
            
            // Проверяем, что данные загрузились
            if (!clipHistory || clipHistory.length === 0) {
                console.log('Loading data for workspace:', this.activeWorkspace);
                // Пробуем загрузить еще раз
                await new Promise(resolve => setTimeout(resolve, 200));
                const retryHistory = await this._getCache();
                if (retryHistory && retryHistory.length > 0) {
                    retryHistory.forEach(entry => this._addEntry(entry));
                    this._selectMenuItem(this.clipItemsRadioGroup[retryHistory.length - 1]);
                }
            } else {
                clipHistory.forEach(entry => this._addEntry(entry));
                this._selectMenuItem(this.clipItemsRadioGroup[clipHistory.length - 1]);
            }
        } catch (e) {
            console.error('Failed to switch workspace:', e);
            this._showNotification(_("Failed to switch workspace"));
        }
    }

    // Добавим метод для сохранения конфигурации
    _saveWorkspacesConfig() {
        this.registry.saveWorkspacesConfig(this.workspaces, this.activeWorkspace);
    }

    _switchToPreviousWorkspace() {
        const currentIndex = this.workspaces.indexOf(this.activeWorkspace);
        // Вычисляем предыдущий индекс с учетом цикличности
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : this.workspaces.length - 1;
        const prevWorkspace = this.workspaces[prevIndex];
        
        this._switchWorkspace(prevWorkspace);
        
        // Обновляем визуальное выделение кнопок
        const workspaceButtons = this.menu.box.get_children()
            .find(child => child.style_class === 'workspace-buttons-container')
            .get_children()
            .filter(child => child.style_class === 'workspace-button'); // Фильтруем только кнопки workspace
            
        workspaceButtons.forEach(button => button.remove_style_pseudo_class('active'));
        workspaceButtons[prevIndex].add_style_pseudo_class('active');
    }

    _switchToNextWorkspace() {
        const currentIndex = this.workspaces.indexOf(this.activeWorkspace);
        // Вычисляем следующий индекс с учетом цикличности
        const nextIndex = currentIndex < this.workspaces.length - 1 ? currentIndex + 1 : 0;
        const nextWorkspace = this.workspaces[nextIndex];
        
        this._switchWorkspace(nextWorkspace);
        
        // Обновляем визуальное выделение кнопок
        const workspaceButtons = this.menu.box.get_children()
            .find(child => child.style_class === 'workspace-buttons-container')
            .get_children()
            .filter(child => child.style_class === 'workspace-button'); // Фильтруем только кнопки workspace
            
        workspaceButtons.forEach(button => button.remove_style_pseudo_class('active'));
        workspaceButtons[nextIndex].add_style_pseudo_class('active');
    }
});

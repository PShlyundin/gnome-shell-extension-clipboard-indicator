import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import { PrefsFields } from './constants.js';

const FileQueryInfoFlags = Gio.FileQueryInfoFlags;
const FileCopyFlags = Gio.FileCopyFlags;
const FileTest = GLib.FileTest;

export class Registry {
    constructor(extension) {
        this.extension = extension;
        this.cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'clipboard-indicator']);
        GLib.mkdir_with_parents(this.cacheDir, 0o775);
    }

    _getWorkspaceDir(workspace) {
        if (!workspace) {
            console.error('Workspace name is undefined');
            workspace = 'default';
        }
        const dir = GLib.build_filenamev([this.cacheDir, workspace]);
        GLib.mkdir_with_parents(dir, 0o775);
        return dir;
    }

    _getCacheFile(workspace) {
        return GLib.build_filenamev([this._getWorkspaceDir(workspace), 'clipboard.json']);
    }

    _getImagesCacheDir(workspace) {
        return this._getWorkspaceDir(workspace);
    }

    async read(workspace) {
        const path = this._getCacheFile(workspace);
        if (!GLib.file_test(path, FileTest.EXISTS)) {
            return [];
        }

        try {
            const [success, contents] = GLib.file_get_contents(path);
            if (!success) {
                return [];
            }

            const decoder = new TextDecoder();
            const entries = JSON.parse(decoder.decode(contents));
            return entries.map(entry => {
                try {
                    let bytes;
                    if (Array.isArray(entry.content)) {
                        bytes = new Uint8Array(entry.content);
                    } else {
                        bytes = entry.content;
                    }
                    return new ClipboardEntry(
                        entry.mimeType || entry.mimetype,
                        bytes,
                        entry.favorite || false
                    );
                } catch (e) {
                    console.error('Failed to create ClipboardEntry:', e);
                    return null;
                }
            }).filter(entry => entry !== null);
        } catch (e) {
            console.error('Failed to read clipboard cache file:', e);
            return [];
        }
    }

    write(entries, workspace) {
        const path = this._getCacheFile(workspace);
        try {
            const encoder = new TextEncoder();
            const contents = encoder.encode(JSON.stringify(
                entries.map(e => e.toJSON())
            ));
            
            GLib.file_set_contents(path, contents);
        } catch (e) {
            console.error('Failed to write clipboard cache file:', e);
        }
    }

    // Метод для очистки данных workspace
    clearWorkspace(workspace) {
        const dir = this._getWorkspaceDir(workspace);
        try {
            // Удаляем все файлы в директории
            const dirFile = Gio.File.new_for_path(dir);
            const enumerator = dirFile.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
            
            let fileInfo;
            while ((fileInfo = enumerator.next_file(null))) {
                const child = dirFile.get_child(fileInfo.get_name());
                child.delete(null);
            }
            
            // Удаляем саму директорию
            dirFile.delete(null);
        } catch (e) {
            console.error('Failed to clear workspace:', e);
        }
    }

    // Обновляем методы для работы с изображениями
    getImagePath(entry, workspace) {
        if (!workspace) {
            console.error('Workspace name is undefined');
            workspace = 'default';
        }
        if (!entry || !entry.imageHash) {
            console.error('Invalid entry or imageHash');
            return null;
        }
        return GLib.build_filenamev([this._getImagesCacheDir(workspace), entry.imageHash]);
    }

    writeEntryFile(entry, workspace) {
        if (!entry || !entry.isImage()) return;
        if (!workspace) {
            console.error('Workspace name is undefined');
            workspace = 'default';
        }
        
        const path = this.getImagePath(entry, workspace);
        if (!path) return;
        
        try {
            const bytes = entry.asBytes().get_data();
            if (!bytes) {
                console.error('No image data to write');
                return;
            }
            GLib.file_set_contents(path, bytes);
            return true;
        } catch (e) {
            console.error('Failed to write image file:', e);
            return false;
        }
    }

    deleteEntryFile(entry, workspace) {
        if (!entry.isImage()) return;
        
        const path = this.getImagePath(entry, workspace);
        try {
            GLib.unlink(path);
        } catch (e) {
            console.error('Failed to delete image file:', e);
        }
    }

    // Добавим методы для работы с конфигурацией workspace'ов
    _getWorkspacesConfigFile() {
        return GLib.build_filenamev([this.cacheDir, 'workspaces.json']);
    }

    saveWorkspacesConfig(workspaces, activeWorkspace) {
        const path = this._getWorkspacesConfigFile();
        try {
            const config = {
                workspaces: workspaces,
                activeWorkspace: activeWorkspace
            };
            const encoder = new TextEncoder();
            const contents = encoder.encode(JSON.stringify(config));
            GLib.file_set_contents(path, contents);
        } catch (e) {
            console.error('Failed to save workspaces config:', e);
        }
    }

    loadWorkspacesConfig() {
        const path = this._getWorkspacesConfigFile();
        const defaultConfig = {
            workspaces: ['Workspace1', 'Workspace2', 'Workspace3'],
            activeWorkspace: 'Workspace1'
        };

        if (!GLib.file_test(path, FileTest.EXISTS)) {
            // Сохраняем дефолтную конфигурацию при первом запуске
            this.saveWorkspacesConfig(defaultConfig.workspaces, defaultConfig.activeWorkspace);
            return defaultConfig;
        }

        try {
            const [success, contents] = GLib.file_get_contents(path);
            if (!success) {
                return defaultConfig;
            }

            const decoder = new TextDecoder();
            const config = JSON.parse(decoder.decode(contents));
            
            // Проверяем валидность загруженной конфигурации
            if (!config || !Array.isArray(config.workspaces) || !config.workspaces.length || !config.activeWorkspace) {
                console.error('Invalid workspace config, using default');
                return defaultConfig;
            }

            // Проверяем существование директорий для каждого workspace
            config.workspaces.forEach(workspace => {
                const dir = this._getWorkspaceDir(workspace);
                if (!GLib.file_test(dir, FileTest.EXISTS)) {
                    GLib.mkdir_with_parents(dir, 0o775);
                }
            });

            // Проверяем, что активный workspace существует в списке
            if (!config.workspaces.includes(config.activeWorkspace)) {
                config.activeWorkspace = config.workspaces[0];
            }

            return config;
        } catch (e) {
            console.error('Failed to load workspaces config:', e);
            return defaultConfig;
        }
    }

    async getEntryAsImage(entry, workspace) {
        if (!entry || !entry.isImage()) return null;
        
        const path = this.getImagePath(entry, workspace);
        if (!path) return null;

        // Проверяем существование файла
        if (!GLib.file_test(path, FileTest.EXISTS)) {
            // Пробуем записать файл
            const written = await this.writeEntryFile(entry, workspace);
            if (!written) return null;
        }

        try {
            const file = Gio.File.new_for_path(path);
            const [success, contents] = await new Promise((resolve) => {
                file.load_contents_async(null, (source, result) => {
                    try {
                        resolve(source.load_contents_finish(result));
                    } catch (e) {
                        console.error('Failed to load image contents:', e);
                        resolve([false, null]);
                    }
                });
            });
            
            if (!success || !contents) {
                console.error('Failed to load image from:', path);
                return null;
            }

            const gicon = Gio.BytesIcon.new(GLib.Bytes.new(contents));
            const image = new St.Icon({
                gicon: gicon,
                icon_size: 24
            });
            
            return image;
        } catch (e) {
            console.error('Failed to load image:', e);
            return null;
        }
    }

    async renameWorkspace(oldName, newName) {
        // Получаем путь к старой и новой директориям
        const oldPath = GLib.build_filenamev([this.cacheDir, oldName]);
        const newPath = GLib.build_filenamev([this.cacheDir, newName]);
        
        try {
            const oldFile = Gio.File.new_for_path(oldPath);
            const newFile = Gio.File.new_for_path(newPath);
            
            // Проверяем существование старой директории
            if (oldFile.query_exists(null)) {
                // Создаем новую директорию если её нет
                if (!newFile.query_exists(null)) {
                    newFile.make_directory_with_parents(null);
                }
                
                // Добавляем задержку перед копированием
                await new Promise(resolve => setTimeout(resolve, 100));
                
                // Копируем все файлы из старой директории в новую
                const enumerator = oldFile.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
                let fileInfo;
                while ((fileInfo = enumerator.next_file(null))) {
                    const fileName = fileInfo.get_name();
                    const sourceFile = oldFile.get_child(fileName);
                    const targetFile = newFile.get_child(fileName);
                    
                    // Копируем файл
                    sourceFile.copy(targetFile, Gio.FileCopyFlags.OVERWRITE, null, null);
                }
                
                // Добавляем задержку перед удалением старой директории
                await new Promise(resolve => setTimeout(resolve, 100));
                
                // Удаляем старую директорию после успешного копирования
                this.clearWorkspace(oldName);
                
                // Обновляем конфигурацию
                const config = await this.loadWorkspacesConfig();
                if (config) {
                    const index = config.workspaces.indexOf(oldName);
                    if (index !== -1) {
                        config.workspaces[index] = newName;
                        if (config.activeWorkspace === oldName) {
                            config.activeWorkspace = newName;
                        }
                        this.saveWorkspacesConfig(config.workspaces, config.activeWorkspace);
                    }
                }
            }
        } catch (e) {
            console.error('Failed to rename workspace directory:', e);
            return false;
        }
        return true;
    }
}

export class ClipboardEntry {
    #mimetype;
    #bytes;
    #favorite;
    #imageHash;

    constructor (mimetype, bytes, favorite) {
        this.#mimetype = mimetype || 'text/plain';
        
        // Преобразуем строку в Uint8Array если нужно
        if (typeof bytes === 'string') {
            this.#bytes = new TextEncoder().encode(bytes);
        } else if (Array.isArray(bytes)) {
            this.#bytes = new Uint8Array(bytes);
        } else if (bytes instanceof Uint8Array) {
            this.#bytes = bytes;
        } else {
            this.#bytes = new Uint8Array();
        }
        
        this.#favorite = !!favorite;
        
        // Генерируем hash для изображений
        if (this.isImage()) {
            this.#imageHash = this.#generateHash();
        }
    }

    #generateHash() {
        // Проверяем, что bytes существует и является Uint8Array
        if (!this.#bytes || !(this.#bytes instanceof Uint8Array)) {
            return 'default-hash';
        }
        
        try {
            // Используем только первые 1000 байт для ускорения
            const bytesToHash = this.#bytes.slice(0, 1000);
            return Array.from(bytesToHash)
                .reduce((hash, byte) => ((hash << 5) - hash) + byte, 5381)
                .toString(36);
        } catch (e) {
            console.error('Failed to generate hash:', e);
            return 'error-hash-' + Date.now();
        }
    }

    get imageHash() {
        return this.#imageHash;
    }

    // Добавим метод для сериализации
    toJSON() {
        return {
            mimeType: this.#mimetype,
            content: this.isText() ? this.getStringValue() : Array.from(this.#bytes),
            favorite: this.#favorite,
            imageHash: this.#imageHash
        };
    }

    // Добавим статический метод для проверки текстового типа
    static isText(mimetype) {
        return mimetype.startsWith('text/') ||
            mimetype === 'STRING' ||
            mimetype === 'UTF8_STRING';
    }

    // Добавим метод для получения содержимого
    getContent() {
        if (this.isText()) {
            return this.getStringValue();
        }
        return this.#bytes;
    }

    mimetype() {
        return this.#mimetype;
    }

    getStringValue() {
        if (this.isImage()) {
            return `[Image ${this.#bytes.length}]`;
        }
        try {
            return new TextDecoder().decode(this.#bytes);
        } catch (e) {
            console.error('Failed to decode bytes:', e);
            return '[Invalid content]';
        }
    }

    isFavorite() {
        return this.#favorite;
    }

    set favorite(val) {
        this.#favorite = !!val;
    }

    isText() {
        return ClipboardEntry.isText(this.#mimetype);
    }

    isImage() {
        return this.#mimetype.startsWith('image/');
    }

    asBytes() {
        return GLib.Bytes.new(this.#bytes);
    }

    equals(otherEntry) {
        return this.getStringValue() === otherEntry.getStringValue();
    }
}

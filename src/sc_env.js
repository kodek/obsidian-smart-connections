import {
  SmartSources,
  SmartSource,
  SmartBlocks,
  SmartBlock,
} from "./sc_entities.js";
import { DataviewSocket } from "./dataview_socket.js";
import templates from "../build/views.json" assert { type: "json" };
import ejs from "../ejs.min.cjs";
import { ScChatModel } from "./chat/sc_chat_model.js";
import { ScChatsUI } from "./chat/sc_chats_ui.js";
import { ScChats } from "./chat/sc_chats.js";
import { ScActions } from "./sc_actions.js";
import { SmartChunks } from 'smart-chunks/smart_chunks.js';
import { SmartEmbedModel } from "smart-embed-model";
import { SmartFs } from 'smart-file-system/smart_fs.js';
import { ObsidianSmartFsAdapter } from 'smart-file-system/adapters/obsidian.js';

export class ScEnv {
  constructor(plugin, opts={}) {
    this.sc_adapter_class = opts.sc_adapter_class;
    this.main = plugin;
    this.plugin = this.main; // DEPRECATED: use this.main instead of this.plugin
    this.config = this.main.settings;
    this.data_path = this.config.smart_connections_folder;
    this.collections = {
      smart_sources: SmartSources,
      smart_blocks: SmartBlocks,
    };
    this.collection_types = {
      SmartSources,
      SmartBlocks,
    };
    this.item_types = {
      SmartSource,
      SmartBlock,
    };
    this.smart_embed_active_models = {};
    this.local_model_type = 'Web';
    this.dv_ws = null;
    this.chat = null;
    // references
    this.ejs = ejs;
    this.templates = templates;
    this.modules = { SmartEmbedModel };
    // cache
    this.connections_cache = {};
  }
  get chat_classes() { return { ScActions, ScChatsUI, ScChats, ScChatModel }; }
  get file_exclusions() {
    return (this.plugin.settings.file_exclusions?.length) ? this.plugin.settings.file_exclusions.split(",").map((file) => file.trim()) : [];
  }
  get folder_exclusions() {
    return (this.plugin.settings.folder_exclusions?.length) ? this.plugin.settings.folder_exclusions.split(",").map((folder) => {
      folder = folder.trim();
      if (folder.slice(-1) !== "/") return folder + "/";
      return folder;
    }) : [];
  }
  get excluded_headings() {
    if (this._excluded_headings) return this._excluded_headings;
    return this._excluded_headings = (this.plugin.settings.excluded_headings?.length) ? this.plugin.settings.excluded_headings.split(",").map((heading) => heading.trim()) : [];
  }
  get system_prompts() { return this.plugin.app.vault.getMarkdownFiles().filter(file => file.path.includes(this.config.system_prompts_folder) || file.path.includes('.prompt') || file.path.includes('.sp')); }
  get settings() { return this.main.settings; }
  // SMART FS
  get fs() {
    if(!this.smart_fs) this.smart_fs = new SmartFs(this, {
      adapter: ObsidianSmartFsAdapter,
      exclude_patterns: [
        ...(this.file_exclusions || []),
        ...(this.folder_exclusions || []).map(folder => `${folder}**`),
        this.settings.smart_connections_folder + "/**",
      ],
      smart_env_data_folder: this.settings.smart_connections_folder,
    });
    return this.smart_fs;
  }
  // DO: Reviewed init_ methods for replacing with new SmartEnv architecture
  async init() {
    this.smart_chunks = new SmartChunks(this, {...this.config, skip_blocks_with_headings_only: true});
    this.init_chat_model();
    DataviewSocket.create(this, 37042); // Smart Connect
    // this.smart_markdown = new SmartMarkdown({ ...this.config, skip_blocks_with_headings_only: true }); // initialize smart markdown (before collections, b/c collections use smart markdown)
    await this.init_entities();
    await this.init_import();
    await this.init_chat();
  }
  get obsidian_is_syncing() {
    const obsidian_sync_instance = this.main.app?.internalPlugins?.plugins?.sync?.instance;
    if(!obsidian_sync_instance) return false; // if no obsidian sync instance, not syncing
    if(obsidian_sync_instance?.syncStatus.startsWith('Uploading')) return false; // if uploading, don't wait for obsidian sync
    return obsidian_sync_instance?.syncing;
  }
  // load one at a time to re-use embed models (smart-entities-2)
  async init_entities() {
    while(this.obsidian_is_syncing){
      console.log("Smart Connections: Waiting for Obsidian Sync to finish");
      await new Promise(r => setTimeout(r, 1000));
    }
    if(this.plugin.is_initializing_entities) return console.log('already init entities'); // Check if already initializing
    this.plugin.is_initializing_entities = true; // Set flag to true to indicate initialization has started
    this.smart_sources = new this.collection_types.SmartSources(this, { adapter_class: this.sc_adapter_class, custom_collection_name: 'smart_sources' });
    this.smart_blocks = new this.collection_types.SmartBlocks(this, { adapter_class: this.sc_adapter_class, custom_collection_name: 'smart_blocks' });
    // await this.check_for_smart_connect_import_api(); // TEMP DISABLED since updated embedding processing logic (v2.1.87)
    this.smart_sources.merge_defaults();
    this.smart_blocks.merge_defaults();
    await this.smart_blocks.load_smart_embed();
    await this.smart_sources.load(); // also loads smart blocks
    this.plugin.is_initializing_entities = false; // Reset flag after initialization is complete
    this.entities_loaded = true;
  }
  // initiate import of smart notes, shows notice before starting embedding
  async init_import() { if (this.smart_sources.smart_embed || this.smart_blocks.smart_embed) this.smart_sources.import(); }
  init_chat_model(chat_model_platform_key=null) {
    let chat_model_config = {};
    chat_model_platform_key = chat_model_platform_key ?? this.config.chat_model_platform_key;
    if(chat_model_platform_key === 'open_router' && !this.plugin.settings[chat_model_platform_key]?.api_key) chat_model_config.api_key = process.env.DEFAULT_OPEN_ROUTER_API_KEY;
    else chat_model_config = this.plugin.settings[chat_model_platform_key] ?? {};
    this.chat_model = new this.chat_classes.ScChatModel(this, chat_model_platform_key, {...chat_model_config });
    this.chat_model._request_adapter = this.plugin.obsidian.requestUrl;
  }
  async init_chat(){
    this.actions = new this.chat_classes.ScActions(this);
    this.actions.init();
    // wait for chat_view containerEl to be available
    while (!this.plugin.chat_view?.containerEl) await new Promise(r => setTimeout(r, 300));
    this.chat_ui = new this.chat_classes.ScChatsUI(this, this.plugin.chat_view.container);
    this.chats = new this.chat_classes.ScChats(this);
    await this.chats.load_all();
  }
  save() {
    this.smart_sources.save();
    this.smart_blocks.save();
  }
  // NEEDS REVIEW: Can unload/reload be handled better?
  async reload_entities() {
    console.log("Smart Connections: reloading entities");
    this.unload_entities();
    if(this.plugin.is_initializing_entities) this.plugin.is_initializing_entities = false; // reset flag
    await this.init_entities();
  }
  async reload() {
    this.unload();
    this.config = this.plugin.settings;
    await this.init();
  }
  unload() {
    this.unload_entities();
    this.smart_embed_active_models = {};
    if(this.dv_ws) this.dv_ws.unload();
  }
  unload_entities() {
    this.entities_loaded = false;
    if (this.smart_sources) this.smart_sources.unload();
    this.smart_sources = null;
    if (this.smart_blocks) this.smart_blocks.unload();
    this.smart_blocks = null;
  }
  // Smart Connect integration
  async check_for_smart_connect_import_api() {
    try {
      const request_adapter = this.plugin.obsidian?.requestUrl || null;
      const sc_local = !request_adapter ? await fetch('http://localhost:37421/') : await request_adapter({ url: 'http://localhost:37421/', method: 'GET' });
      // console.log(sc_local);
      if (sc_local.status === 200) {
        console.log('Local Smart Connect server found');
        this.smart_sources.import = async (files = null) => {
          const requestUrl = this.plugin.obsidian.requestUrl;
          const resp = await requestUrl({ url: 'http://localhost:37421/import_entities', method: 'POST' });
          console.log("import resp: ", resp.json);
          if (resp.json.notice === 'recently imported') {
            this.plugin.notices.show('imported from Smart Connect', [`[Smart Connect] ${resp.json.message}`, resp.json.notice], { timeout: 10000 });
            return;
          }
          this.plugin.notices.show('importing from Smart Connect', [`[Smart Connect] ${resp.json.message}`, resp.json.notice], { timeout: 10000 });
          let follow_up_resp = { json: { message: '' } };
          while (follow_up_resp.json.message !== 'recently imported') {
            follow_up_resp = await requestUrl({ url: 'http://localhost:37421/import_entities', method: 'POST' });
            this.plugin.notices.remove('importing from Smart Connect');
            this.plugin.notices.show('importing from Smart Connect', [`[Smart Connect] ${follow_up_resp.json.message}`, follow_up_resp.json.notice], { timeout: 10000 });
            await new Promise(resolve => setTimeout(resolve, 3000));
            console.log("follow_up_resp: ", follow_up_resp);
          }
          this.plugin.notices.remove('importing from Smart Connect');
          this.plugin.notices.show('imported from Smart Connect', [`[Smart Connect] ${follow_up_resp.json.message}`, follow_up_resp.json.notice], { timeout: 10000 });
          console.log("done importing from Smart Connect");
          this.reload_entities();
        };
        this.smart_blocks.import = this.smart_sources.import;
        console.log("smart_sources.import: ", this.smart_sources.import);
        console.log("smart_blocks.import: ", this.smart_blocks.import);
        // return;
      }
    } catch (err) {
      console.log('Could not connect to local Smart Connect server');
    }
  }
}
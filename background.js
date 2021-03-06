// bookmark folder that contains the session folders
var bookmarkFolderID = null;

function setSessionFolder(bmFolderID) {
	return browser.bookmarks.getSubTree(bmFolderID).then(data => {
		return utils.isBMFolder(data[0]) ?
			Promise.resolve(data[0]) :
			Promise.reject(new Error("thats not a folder"));
	}).then(folder => {
		bookmarkFolderID = folder.id;

		console.log("[TA] BM folder ID set to " + bookmarkFolderID);

		return Promise.all([
			browser.storage.local.set({
				bookmarkFolderID: folder.id
			}),
			browser.runtime.sendMessage({
				command: "root-updated"
			})
		]);
	});
}

browser.browserAction.setBadgeBackgroundColor({
	color: "#0A84FF"
});

browser.browserAction.setTitle({
	title: `Tabs Aside ${browser.runtime.getManifest().version}`
});

// load browser action icon
browser.storage.local.get("ba-icon").then(data => {
	if(data["ba-icon"]) {
		utils.setBrowserActionIcon(data["ba-icon"]);
	}
});

browser.storage.local.get("version").then(data => {
	if (data.version) {
		console.assert(data.version === 1, "[TA] Invalid data version!");
	} else {
		browser.storage.local.set({
			version: 1
		});

		return browser.storage.local.get("session").then(data => {
			if (data.session) {
				browser.storage.local.remove("session");
			}
		});
	}
}).then(() => {
	// load sessions root folder (Tabs Aside folder)
	// (verify there actually is a folder with that ID)
	return getSessionRootFolderID().then(folderID => {
		bookmarkFolderID = folderID;
	}, e => {
		console.log(e);

		// checking if there already is a tabs aside folder
		console.log("[TA] searching for a 'Tabs Aside' folder");
		return browser.bookmarks.search({title:"Tabs Aside"}).then(data => {
			let folders = data.filter(bm => utils.isBMFolder(bm));
			
			if (folders.length > 0) {
				// Tabs Aside folder found
				console.log(`[TA] 'Tabs Aside' folder (${folders[0].id}) found.`);

				return setSessionFolder(folders[0].id);
			} else {
				// Tabs Aside folder not found
				console.log("[TA] Creating a new bookmark folder...");
				return createTabsAsideFolder();
			}
		});
	});
}).then(() => {
	updateTabMenus();
}).catch(error => console.log("[TA] Error: " + error));

function createTabsAsideFolder() {
	return browser.bookmarks.create({
		title: "Tabs Aside"
	}).then(bm => {
		console.log("[TA] Folder successfully created");

		return setSessionFolder(bm.id).then(refresh);
	}).catch(error => console.log("Error: " + error));
}

function asideMessageHandler(message) {
	let promise, updateType;

	if (message.tabs) {
		let closeTabs = message.command !== "save";

		// newtab property is optional (defaults to false)
		if (message.newtab) {
			// open a new empty tab (async)
			browser.tabs.create({});
		}

		if (message.sessionID) {
			updateType = "session-updated";

			// add tabs to existing session (all async)
			promise = Promise.all(
				message.tabs.map(
					tab => addTabToSession(message.sessionID, tab, closeTabs)
				)
			);
		} else {
			updateType = "session-created";

			// create a new session:

			// custom title?
			let title = (message.title) ? message.title : generateSessionName();

			// tabs aside!
			promise = aside(
				message.tabs,
				closeTabs,
				bookmarkFolderID,
				title
			);
		}

		console.log("sending session update");
		
		// update sidebar
		promise.then(sessionID => {
			return browser.runtime.sendMessage({
				command: "session-update",
				type: updateType,
				sessionID: sessionID
			});
		});

		// update menu
		promise.then(updateTabMenus);
	}

	return promise;
}

// message listener
browser.runtime.onMessage.addListener(message => {
	if (message.command === "aside" || message.command === "save") {
		asideMessageHandler(message);
	} else if (message.command === "updateRoot") {
		setSessionFolder(message.bmID).then(refresh);
	} else if (message.command === "refresh") {
		updateTabMenus();
	} else if (message.command === "ASM") {
		let result = ActiveSessionManager[message.asmcmd].apply(null, message.args || []);

		if (result instanceof Promise) {
			result.then(
				r => browser.runtime.sendMessage({ class: "ASMResponse", result: r }),
				e => browser.runtime.sendMessage({ class: "ASMResponse", error: e, line: e.lineNumber })
			);
		} else {
			browser.runtime.sendMessage({class:"ASMResponse",result:result});
		}
	} else if(message.command === "session-update") {
		updateTabMenus();
	} else if(message.command === "options-changed") {
		ActiveSessionManager.loadConfiguration();
	} else if(message.command === "root-updated") {
		getSessionRootFolderID().then(folderID => {
			bookmarkFolderID = folderID;
		}).then(updateTabMenus)
		.catch(e => console.error("[TA] " + e));
	}
});

// handle keyboard commands
browser.commands.onCommand.addListener(command => {
	if (command === "tabs-aside") {

		Promise.all([
			utils.getTabs(),
			utils.getActiveTab()
		]).then(data => {
			let tabs = data[0];
			let activeTab = data[1];
			let session = ActiveSessionManager.findSession(activeTab.id);
			let newtab = !utils.containsEmptyTab(tabs);

			if(session) {
				console.log(`[TA] Setting session ${session} aside. (Shift+Alt+Q)`);
				return ActiveSessionManager.setSessionAside(session);
			} else {
				console.log(`[TA] Setting remaining tabs aside. (Shift+Alt+Q)`);
				return asideMessageHandler({
					command: "aside",
					newtab: newtab,
					tabs: tabs.filter(tab => 
						utils.urlFilter(tab.url) 
						&& !ActiveSessionManager.isTabInActiveSession(tab.id)
					)
				});
			}
		}).catch(e => {
			console.error("[TA] command error: " + e);
		});
		
		// does not currently work in Firefox:
		//browser.sidebarAction.open();
	} else {
		console.log(command);
	}
});
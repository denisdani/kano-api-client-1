import Gamification from '../node_modules/gamification-engine/dist/gamification-engine.es6.js';
import GamificationClient from '../lib/gamification.js';

class LocalStorageClient {
    constructor(userId) {
        this.user = userId;
        this.stateKey = `gamification-state-${this.user}`;
        this.queueKey = `gamification-event-queue-${this.user}`;
    }
    getLocalGamificationState() {
        return Promise.resolve(JSON.parse(localStorage.getItem(this.state)) || []);
    }
    setLocalGamificationState(state) {
        return Promise.resolve(localStorage.setItem(this.stateKey, JSON.stringify(state)));
    }
    _getOrInitialiseQueue() {
        let queue;

        try {
            queue = JSON.parse(localStorage.getItem(this.queueKey));

            if (!Array.isArray(queue)) {
                queue = [];
            }
        } catch(error) {
            queue = [];
        }

        return queue;
    }
    emptyQueue() {
        return localStorage.setItem(this.queueKey, JSON.stringify([]));
    }
    queue(eventOrArray) {
        let queue = this._getOrInitialiseQueue();
        if (Array.isArray(eventOrArray)) {
            queue = queue.concat(eventOrArray);
        } else {
            queue.push(eventOrArray);
        }
        return localStorage.setItem(this.queueKey, JSON.stringify(queue));
    }
    getEventQueue() {
        return this._getOrInitialiseQueue();
    }
}

export class OfflineGamificationPlugin {
    constructor(userId) {
        this.userId = userId;
        this.client = new LocalStorageClient(userId);
        this.storage = new Gamification.BrowserStorage({ client: this.client });

        this.engine = new Gamification.Engine(Gamification.RULES, this.storage);

        this.parent = null;
    }

    /**
     * Must be run before attaching plugin to a client.
     *
     * @returns Promise
     */
    prepare() {
        return this.engine.start();
    }

    onInstall(client) {
        if (!this.parent) {
            this.parent = client;
            this.remoteClient = new GamificationClient(this.parent);
            this.remoteClient.plugins = this.remoteClient.plugins.filter(p => !(p instanceof OfflineGamificationPlugin));
        }
    }

    afterData(endpoint, data) {
        if (['getProgress', 'getPartialProgress', 'trigger'].indexOf(endpoint.name) === -1) {
            return Promise.resolve(data);
        }

        let progress;

        /* Only override data when response wasn't spoofed. */
        if (!endpoint.response) {
            switch (endpoint.name) {
            case 'getProgress':
            case 'getPartialProgress':
                if (this.userId === endpoint.params.userId) {
                    return this.engine.overrideStateFromProgress(data).then(() => {
                        return data;
                    });
                }
                break;
            case 'trigger':
                progress = {};

                Object.keys(data).forEach((name) => {
                    progress[name] = data[name].progress;
                });

                return this.engine.overrideStateFromProgress(progress).then(() => {
                    return data;
                });
            }
        }

        return Promise.resolve(data);
    }

    _dispatchEventsAndSync(queue) {
        let cachedData;
        return this.remoteClient.trigger(queue).then(() => {
            return this.remoteClient.getProgress(this.userId);
        }).then((data) => {
            cachedData = data;
            return this.engine.overrideStateFromProgress(data);
        }).then(() => {
            return cachedData;
        });
    }

    _filterProgress(progress, ruleIds) {
        const response = {};

        Object.keys(progress)
            .filter(ruleName => ruleIds.indexOf(ruleName) >= 0)
            .forEach((name) => {
                response[name] = progress[name];
            });

        return response;
    }

    beforeFetch(endpoint) {
        const queue = this.client.getEventQueue();

        /* Skip uploading queue when there aren't any events or there's no internet */
        if (['getProgress', 'getPartialProgress', 'trigger'].indexOf(endpoint.name) === -1 ||
            queue.length === 0 ||
            !navigator.onLine) {

            return Promise.resolve(endpoint);
        }

        return this._dispatchEventsAndSync(queue).then((progress) => {
            this.client.emptyQueue();

            switch (endpoint.name) {
            case 'getProgress':
                endpoint.response = {
                    data: progress
                };
                return Promise.resolve(endpoint);
            case 'getPartialProgress':
                endpoint.response = {
                    data: this._filterProgress(progress.progress, endpoint.params.ruleIds),
                };
                return Promise.resolve(endpoint);
            case 'trigger':
            default:
                return Promise.resolve(endpoint);
            }
        }).catch(() => {
            /* In case of error, carry on with the normal request. */
            return Promise.resolve(endpoint);
        });
    }

    onError(endpoint, response) {
        if (['getProgress', 'getPartialProgress', 'trigger'].indexOf(endpoint.name) === -1) {
            return Promise.resolve(endpoint);
        }

        // Future TODO posisbly print/log error here?

        let events;

        switch (endpoint.name) {
        case 'getProgress':
            endpoint.response = {
                data: this.engine.getProgress(),
            };
            return Promise.resolve(endpoint);
        case 'getPartialProgress':
            endpoint.response = {
                data: this._filterProgress(this.engine.getProgress(), endpoint.params.ruleIds),
            };
            return Promise.resolve(endpoint);
        case 'trigger':
            events = endpoint.params.eventOrArray;

            if (!Array.isArray(events)) {
                events = [events];
            }
            this.client.queue(events);

            /* Reset state changes log */
            this.engine.rules.forEach((rule) => {
                if (rule.state) {
                    rule.state.changes = null;
                }
            });

            return this.engine.transaction(events).then((response) => {
                endpoint.response = { data: response };
                this.engine.save();
                return endpoint;
            });
        }

        return Promise.resolve(endpoint);
    }
}
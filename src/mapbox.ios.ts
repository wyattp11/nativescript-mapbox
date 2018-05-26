import * as fs from "tns-core-modules/file-system";
import * as imgSrc from "tns-core-modules/image-source";
import * as utils from "tns-core-modules/utils/utils";
import * as http from "tns-core-modules/http";

import {
  AddExtrusionOptions,
  AddGeoJsonClusteredOptions,
  AddPolygonOptions,
  AddPolylineOptions,
  AnimateCameraOptions,
  DeleteOfflineRegionOptions,
  DownloadOfflineRegionOptions,
  LatLng,
  ListOfflineRegionsOptions,
  MapboxApi,
  MapboxCommon,
  MapboxMarker,
  MapboxViewBase,
  MapStyle,
  OfflineRegion,
  SetCenterOptions,
  SetTiltOptions,
  SetViewportOptions,
  SetZoomLevelOptions,
  ShowOptions,
  UserLocation,
  Viewport
} from "./mapbox.common";
import { Color } from "tns-core-modules/color";

// Export the enums for devs not using TS
export { MapStyle };

let _markers = [];
let _markerIconDownloadCache = [];
let _mapView: MGLMapView;
let _mapbox: any = {};
let _delegate: any;

const _setMapboxMapOptions = (mapView: MGLMapView, settings) => {
  mapView.logoView.hidden = settings.hideLogo;
  mapView.attributionButton.hidden = settings.hideAttribution;
  mapView.showsUserLocation = settings.showUserLocation;
  mapView.compassView.hidden = settings.hideCompass;
  mapView.rotateEnabled = !settings.disableRotation;
  mapView.scrollEnabled = !settings.disableScroll;
  mapView.zoomEnabled = !settings.disableZoom;
  mapView.allowsTilting = !settings.disableTilt;
  // mapView.showsScale = settings.showScale; // TODO, default false
  // mapView.showsHeading = true;
  // mapView.showsUserHeadingIndicator = true;

  if (settings.center && settings.center.lat && settings.center.lng) {
    let centerCoordinate = CLLocationCoordinate2DMake(settings.center.lat, settings.center.lng);
    mapView.setCenterCoordinateZoomLevelAnimated(centerCoordinate, settings.zoomLevel, false);
  } else {
    mapView.setZoomLevelAnimated(settings.zoomLevel, false);
  }

  // TODO not sure this works as planned.. perhaps better to listen for rotate events ([..didrotate..] and fix the frame
  mapView.autoresizingMask = UIViewAutoresizing.FlexibleWidth | UIViewAutoresizing.FlexibleHeight;
};

const _getMapStyle = (input: any) => {
  if (/^mapbox:\/\/styles/.test(input)) {
    // allow for a style URL to be passed
    return NSURL.URLWithString(input);
  } else if (input === MapStyle.LIGHT || input === MapStyle.LIGHT.toString()) {
    return MGLStyle.lightStyleURL;
  } else if (input === MapStyle.DARK || input === MapStyle.DARK.toString()) {
    return MGLStyle.darkStyleURL;
  } else if (input === MapStyle.OUTDOORS || input === MapStyle.OUTDOORS.toString()) {
    return MGLStyle.outdoorsStyleURL;
  } else if (input === MapStyle.SATELLITE || input === MapStyle.SATELLITE.toString()) {
    return MGLStyle.satelliteStyleURL;
  } else if (input === MapStyle.SATELLITE_STREETS || input === MapStyle.SATELLITE_STREETS.toString()) {
    return MGLStyle.satelliteStreetsStyleURL;
  } else if (input === MapStyle.TRAFFIC_DAY || input === MapStyle.TRAFFIC_DAY.toString()) {
    return NSURL.URLWithString("mapbox://styles/mapbox/traffic-day-v2");
  } else if (input === MapStyle.TRAFFIC_NIGHT || input === MapStyle.TRAFFIC_NIGHT.toString()) {
    return NSURL.URLWithString("mapbox://styles/mapbox/traffic-night-v2");
  } else {
    return MGLStyle.streetsStyleURL;
  }
};

/*************** XML definition START ****************/
export class MapboxView extends MapboxViewBase {

  private mapView: MGLMapView;
  private delegate: MGLMapViewDelegate;

  getNativeMapView(): any {
    return this.mapView;
  }

  public createNativeView(): Object {
    let v = super.createNativeView();
    setTimeout(() => {
      this.initMap();
    }, 0);
    return v;
  }

  initMap(): void {
    if (!this.mapView && this.config.accessToken) {
      this.mapbox = new Mapbox();
      let settings = Mapbox.merge(this.config, Mapbox.defaults);
      let drawMap = () => {
        MGLAccountManager.accessToken = settings.accessToken;
        this.mapView = MGLMapView.alloc().initWithFrameStyleURL(CGRectMake(0, 0, this.nativeView.frame.size.width, this.nativeView.frame.size.height), _getMapStyle(settings.style));
        this.mapView.delegate = this.delegate = MGLMapViewDelegateImpl.new().initWithCallback(() => {
          this.notify({
            eventName: MapboxViewBase.mapReadyEvent,
            object: this,
            map: this,
            ios: this.mapView
          });
          // no permission required, but to align with Android we fire the event anyway
          this.notify({
            eventName: MapboxViewBase.locationPermissionGrantedEvent,
            object: this,
            map: this,
            ios: this.mapView
          });
        });
        _setMapboxMapOptions(this.mapView, settings);
        _markers = [];
        this.nativeView.addSubview(this.mapView);
      };
      setTimeout(drawMap, settings.delay ? settings.delay : 0);
    }
  }

  public onLayout(left: number, top: number, right: number, bottom: number): void {
    super.onLayout(left, top, right, bottom);
    if (this.mapView) {
      this.mapView.layer.frame = this.ios.layer.bounds;
    }
  }
}

/*************** XML definition END ****************/

export class Mapbox extends MapboxCommon implements MapboxApi {
  show(options: ShowOptions): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        const settings: ShowOptions = Mapbox.merge(options, Mapbox.defaults);

        // let directions = MBDirections.alloc().initWithAccessToken(arg.accessToken);
        // alert("directions: " + directions);

        // if no accessToken was set the app may crash
        if (settings.accessToken === undefined) {
          reject("Please set the 'accessToken' parameter");
          return;
        }

        // if already added, make sure it's removed first
        if (_mapView) {
          _mapView.removeFromSuperview();
        }

        const view = utils.ios.getter(UIApplication, UIApplication.sharedApplication).keyWindow.rootViewController.view,
            frameRect = view.frame,
            mapFrame = CGRectMake(
                settings.margins.left,
                settings.margins.top,
                frameRect.size.width - settings.margins.left - settings.margins.right,
                frameRect.size.height - settings.margins.top - settings.margins.bottom
            ),
            styleURL = _getMapStyle(settings.style);

        MGLAccountManager.accessToken = settings.accessToken;
        _mapbox.mapView = MGLMapView.alloc().initWithFrameStyleURL(mapFrame, styleURL);
        _setMapboxMapOptions(_mapbox.mapView, settings);

        _mapbox.mapView.delegate = _delegate = MGLMapViewDelegateImpl.new().initWithCallback(
            (mapView: MGLMapView) => {
              resolve({
                ios: mapView
              });
            }
        );

        _markers = [];
        _addMarkers(settings.markers);

        // wrapping in a little timeout since the map area tends to flash black a bit initially
        setTimeout(() => {
          view.addSubview(_mapbox.mapView);
        }, 500);

      } catch (ex) {
        console.log("Error in mapbox.show: " + ex);
        reject(ex);
      }
    });
  }

  hide(): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        if (_mapbox.mapView) {
          _mapbox.mapView.removeFromSuperview();
        }
        resolve();
      } catch (ex) {
        console.log("Error in mapbox.hide: " + ex);
        reject(ex);
      }
    });
  }

  unhide(): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        if (_mapbox.mapView) {
          let view = utils.ios.getter(UIApplication, UIApplication.sharedApplication).keyWindow.rootViewController.view;
          view.addSubview(_mapbox.mapView);
          resolve();
        } else {
          reject("No map found");
        }
      } catch (ex) {
        console.log("Error in mapbox.unhide: " + ex);
        reject(ex);
      }
    });
  }

  destroy(nativeMap?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const theMap: MGLMapView = nativeMap || _mapbox.mapView;
      if (theMap) {
        theMap.removeFromSuperview();
        theMap.delegate = null;
        _mapbox = {};
      }
      resolve();
    });
  }

  setMapStyle(style: string | MapStyle, nativeMap?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        const theMap: MGLMapView = nativeMap || _mapbox.mapView;
        theMap.styleURL = _getMapStyle(style);
        resolve();
      } catch (ex) {
        console.log("Error in mapbox.setMapStyle: " + ex);
        reject(ex);
      }
    });
  }

  addMarkers(markers: MapboxMarker[], nativeMap?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        const theMap: MGLMapView = nativeMap || _mapbox.mapView;
        _addMarkers(markers, theMap);
        resolve();
      } catch (ex) {
        console.log("Error in mapbox.addMarkers: " + ex);
        reject(ex);
      }
    });
  }

  removeMarkers(ids?: any, nativeMap?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        const theMap = nativeMap || _mapbox.mapView;
        let markersToRemove: Array<MGLAnnotation> = [];
        for (let m in _markers) {
          let marker = _markers[m];
          if (!ids || (marker.id && ids.indexOf(marker.id) > -1)) {
            markersToRemove.push(marker.ios);
          }
        }

        // remove markers from cache
        if (ids) {
          _markers = _markers.filter((marker) => {
            return ids.indexOf(marker.id) < 0;
          });
        } else {
          _markers = [];
        }

        if (markersToRemove.length > 0) {
          theMap.removeAnnotations(markersToRemove);
        }
        resolve();
      } catch (ex) {
        console.log("Error in mapbox.removeMarkers: " + ex);
        reject(ex);
      }
    });
  }

  setCenter(options: SetCenterOptions, nativeMap?): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        let theMap: MGLMapView = nativeMap || _mapbox.mapView;
        let level = options.level;
        let animated = options.animated === undefined || options.animated;
        let coordinate = CLLocationCoordinate2DMake(options.lat, options.lng);
        theMap.setCenterCoordinateAnimated(coordinate, animated);
        resolve();
        if (level >= 0 && level <= 20) {
          theMap.setZoomLevelAnimated(level, animated);
          resolve();
        } else {
          reject("invalid zoomlevel, use any double value from 0 to 20 (like 8.3)");
        }
      } catch (ex) {
        console.log("Error in mapbox.setCenter: " + ex);
        reject(ex);
      }
    });
  }

  getCenter(nativeMap?): Promise<LatLng> {
    return new Promise((resolve, reject) => {
      try {
        let theMap: MGLMapView = nativeMap || _mapbox.mapView;
        let coordinate = theMap.centerCoordinate;
        resolve({
          lat: coordinate.latitude,
          lng: coordinate.longitude
        });
      } catch (ex) {
        console.log("Error in mapbox.getCenter: " + ex);
        reject(ex);
      }
    });
  }

  set
  
  Level(options: SetZoomLevelOptions, nativeMap?): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        let theMap: MGLMapView = nativeMap || _mapbox.mapView;
        let animated = options.animated === undefined || options.animated;
        let level = options.level;
        if (level >= 0 && level <= 20) {
          theMap.setZoomLevelAnimated(level, animated);
          resolve();
        } else {
          reject("invalid zoomlevel, use any double value from 0 to 20 (like 8.3)");
        }
      } catch (ex) {
        console.log("Error in mapbox.setZoomLevel: " + ex);
        reject(ex);
      }
    });
  }

  getZoomLevel(nativeMap?): Promise<number> {
    return new Promise((resolve, reject) => {
      try {
        let theMap: MGLMapView = nativeMap || _mapbox.mapView;
        resolve(theMap.zoomLevel);
      } catch (ex) {
        console.log("Error in mapbox.getZoomLevel: " + ex);
        reject(ex);
      }
    });
  }

  setTilt(options: SetTiltOptions, nativeMap?): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        let theMap: MGLMapView = nativeMap || _mapbox.mapView;

        let cam = theMap.camera;

        cam.pitch = options.tilt;

        const durationMs = options.duration ? options.duration : 5000;

        theMap.setCameraWithDurationAnimationTimingFunction(
            cam,
            durationMs / 1000,
            CAMediaTimingFunction.functionWithName(kCAMediaTimingFunctionEaseInEaseOut));

        setTimeout(() => {
          resolve();
        }, durationMs);
      } catch (ex) {
        console.log("Error in mapbox.setTilt: " + ex);
        reject(ex);
      }
    });
  }

  getTilt(nativeMap?): Promise<number> {
    return new Promise((resolve, reject) => {
      try {
        let theMap: MGLMapView = nativeMap || _mapbox.mapView;
        resolve(theMap.camera.pitch);
      } catch (ex) {
        console.log("Error in mapbox.getTilt: " + ex);
        reject(ex);
      }
    });
  }

  getUserLocation(nativeMap?): Promise<UserLocation> {
    return new Promise((resolve, reject) => {
      try {
        let theMap: MGLMapView = nativeMap || _mapbox.mapView;
        const loc = theMap.userLocation;
        if (loc === null) {
          reject("Location not available");
        } else {
          resolve({
            location: {
              lat: loc.coordinate.latitude,
              lng: loc.coordinate.longitude
            },
            speed: loc.location.speed
          });
        }
      } catch (ex) {
        console.log("Error in mapbox.getUserLocation: " + ex);
        reject(ex);
      }
    });
  }

  addPolygon(options: AddPolygonOptions, nativeMap?): Promise<any> {
    return new Promise((resolve, reject) => {
      const theMap = nativeMap || _mapbox.mapView;
      const points = options.points;
      if (points === undefined) {
        reject("Please set the 'points' parameter");
        return;
      }

      const coordinateArray = [];
      for (const p in points) {
        coordinateArray.push([points[p].lng, points[p].lat]);
      }

      const polygonID = "polyline_" + (options.id || new Date().getTime());

      if (theMap.style.sourceWithIdentifier(polygonID)) {
        reject("Remove the polyline with this id first with 'removePolylines': " + polygonID);
        return;
      }

      const geoJSON = `{"type": "FeatureCollection", "features": [{"type": "Feature","properties": {},"geometry": {"type": "Polygon", "coordinates": [${JSON.stringify(coordinateArray)}]}}]}`;
      const geoDataStr = NSString.stringWithString(geoJSON);
      const geoData = geoDataStr.dataUsingEncoding(NSUTF8StringEncoding);
      const geoDataBase64Enc = geoData.base64EncodedStringWithOptions(0);
      const geo = NSData.alloc().initWithBase64EncodedStringOptions(geoDataBase64Enc, null);
      const shape = MGLShape.shapeWithDataEncodingError(geo, NSUTF8StringEncoding);
      const source = MGLShapeSource.alloc().initWithIdentifierShapeOptions(polygonID, shape, null);
      theMap.style.addSource(source);

      const layer = MGLFillStyleLayer.alloc().initWithIdentifierSource(polygonID, source);
      layer.fillColor = NSExpression.expressionForConstantValue(!options.fillColor ? UIColor.blackColor : (options.fillColor instanceof Color ? options.fillColor.ios : new Color(options.fillColor).ios));
      layer.fillOpacity = NSExpression.expressionForConstantValue(options.fillOpacity === undefined ? 1 : options.fillOpacity);
      theMap.style.addLayer(layer);

      resolve();
    });
  }

  addPolyline(options: AddPolylineOptions, nativeMap?): Promise<any> {
    return new Promise((resolve, reject) => {
      const theMap: MGLMapView = nativeMap || _mapbox.mapView;
      const points = options.points;
      if (points === undefined) {
        reject("Please set the 'points' parameter");
        return;
      }

      const coordinateArray = [];
      for (const p in points) {
        coordinateArray.push([points[p].lng, points[p].lat]);
      }

      const polylineID = "polyline_" + (options.id || new Date().getTime());

      // this would otherwise crash the app
      if (theMap.style.sourceWithIdentifier(polylineID)) {
        reject("Remove the polyline with this id first with 'removePolylines': " + polylineID);
        return;
      }

      const geoJSON = `{"type": "FeatureCollection", "features": [{"type": "Feature","properties": {},"geometry": {"type": "LineString", "coordinates": ${JSON.stringify(coordinateArray)}}}]}`;
      const geoDataStr = NSString.stringWithString(geoJSON);
      const geoData = geoDataStr.dataUsingEncoding(NSUTF8StringEncoding);
      const geoDataBase64Enc = geoData.base64EncodedStringWithOptions(0);

      const geo = NSData.alloc().initWithBase64EncodedStringOptions(geoDataBase64Enc, null);
      const shape = MGLShape.shapeWithDataEncodingError(geo, NSUTF8StringEncoding);
      const source = MGLShapeSource.alloc().initWithIdentifierShapeOptions(polylineID, shape, null);
      theMap.style.addSource(source);

      const layer = MGLLineStyleLayer.alloc().initWithIdentifierSource(polylineID, source);
      layer.lineColor = NSExpression.expressionForConstantValue(!options.color ? UIColor.blackColor : (options.color instanceof Color ? options.color.ios : new Color(options.color).ios));
      layer.lineWidth = NSExpression.expressionForConstantValue(options.width || 5);
      layer.lineOpacity = NSExpression.expressionForConstantValue(options.opacity === undefined ? 1 : options.opacity);

      theMap.style.addLayer(layer);
      resolve();
    });
  }

  private removePolylineById(theMap, id: any): void {
    const polylineID = "polyline_" + id;
    const layer = theMap.style.layerWithIdentifier(polylineID);
    if (layer !== null) {
      theMap.style.removeLayer(layer);
    }
    const source = theMap.style.sourceWithIdentifier(polylineID);
    if (source !== null) {
      console.log(">>> removing source " + polylineID);
      theMap.style.removeSource(source);
    }
  }

  removePolylines(ids?: Array<any>, nativeMap?): Promise<any> {
    return new Promise((resolve, reject) => {
      let theMap: MGLMapView = nativeMap || _mapbox.mapView;
      ids.map(id => this.removePolylineById(theMap, id));
      resolve();
    });
  }

  animateCamera(options: AnimateCameraOptions, nativeMap?): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        let theMap: MGLMapView = nativeMap || _mapbox.mapView;

        let target = options.target;
        if (target === undefined) {
          reject("Please set the 'target' parameter");
          return;
        }

        let cam = theMap.camera;

        cam.centerCoordinate = CLLocationCoordinate2DMake(target.lat, target.lng);

        if (options.altitude) {
          cam.altitude = options.altitude;
        }

        if (options.bearing) {
          cam.heading = options.bearing;
        }

        if (options.tilt) {
          cam.pitch = options.tilt;
        }

        let durationMs = options.duration ? options.duration : 10000;

        theMap.setCameraWithDurationAnimationTimingFunction(
            cam,
            durationMs / 1000,
            CAMediaTimingFunction.functionWithName(kCAMediaTimingFunctionEaseInEaseOut));

        setTimeout(() => {
          resolve();
        }, durationMs);
      } catch (ex) {
        console.log("Error in mapbox.animateCamera: " + ex);
        reject(ex);
      }
    });
  }

  setOnMapClickListener(listener: (data: LatLng) => void, nativeMap?): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        let theMap: MGLMapView = nativeMap || _mapbox.mapView;

        if (!theMap) {
          reject("No map has been loaded");
          return;
        }

        // adding the tap handler to the map oject so it's not GC'd
        theMap['mapTapHandler'] = MapTapHandlerImpl.initWithOwnerAndListenerForMap(new WeakRef(this), listener, theMap);
        const tapGestureRecognizer = UITapGestureRecognizer.alloc().initWithTargetAction(theMap['mapTapHandler'], "tap");

        // cancel the default tap handler
        for (let i = 0; i < theMap.gestureRecognizers.count; i++) {
          let recognizer: UIGestureRecognizer = theMap.gestureRecognizers.objectAtIndex(i);
          if (recognizer instanceof UITapGestureRecognizer) {
            tapGestureRecognizer.requireGestureRecognizerToFail(recognizer);
          }
        }

        theMap.addGestureRecognizer(tapGestureRecognizer);

        resolve();
      } catch (ex) {
        console.log("Error in mapbox.setOnMapClickListener: " + ex);
        reject(ex);
      }
    });
  }

  setOnScrollListener(listener: (data?: LatLng) => void, nativeMap?: any): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        let theMap: MGLMapView = nativeMap || _mapbox.mapView;

        if (!theMap) {
          reject("No map has been loaded");
          return;
        }

        // adding the pan handler to the map oject so it's not GC'd
        theMap['mapPanHandler'] = MapPanHandlerImpl.initWithOwnerAndListenerForMap(new WeakRef(this), listener, theMap);

        // there's already a pan recognizer, so find it and attach a target action
        for (let i = 0; i < theMap.gestureRecognizers.count; i++) {
          let recognizer: UIGestureRecognizer = theMap.gestureRecognizers.objectAtIndex(i);
          if (recognizer instanceof UIPanGestureRecognizer) {
            recognizer.addTargetAction(theMap['mapPanHandler'], "pan");
            break;
          }
        }

        resolve();
      } catch (ex) {
        console.log("Error in mapbox.setOnScrollListener: " + ex);
        reject(ex);
      }
    });
  }

  setOnFlingListener(listener: () => void, nativeMap?: any): Promise<any> {
    // there's no swipe event we can bind to
    return Promise.reject("'setOnFlingListener' is not supported on iOS");
  }

  setOnCameraMoveListener(listener: () => void, nativeMap?: any): Promise<any> {
    return Promise.reject("'setOnCameraMoveListener' not currently supported on iOS");
  }

  setOnCameraMoveCancelListener(listener: () => void, nativeMap?: any): Promise<any> {
    return Promise.reject("'setOnCameraMoveCancelListener' not currently supported on iOS");
  }

  setOnCameraIdleListener(listener: () => void, nativeMap?: any): Promise<any> {
    return Promise.reject("'setOnCameraIdleListener' not currently supported on iOS");
  }

  getViewport(nativeMap?): Promise<Viewport> {
    return new Promise((resolve, reject) => {
      try {
        let theMap: MGLMapView = nativeMap || _mapbox.mapView;

        if (!theMap) {
          reject("No map has been loaded");
          return;
        }

        let visibleBounds = theMap.visibleCoordinateBounds;
        let bounds = {
          north: visibleBounds.ne.latitude,
          east: visibleBounds.ne.longitude,
          south: visibleBounds.sw.latitude,
          west: visibleBounds.sw.longitude
        };
        resolve({
          bounds: bounds,
          zoomLevel: theMap.zoomLevel
        });
      } catch (ex) {
        console.log("Error in mapbox.getViewport: " + ex);
        reject(ex);
      }
    });
  }

  setViewport(options: SetViewportOptions, nativeMap?): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        let theMap: MGLMapView = nativeMap || _mapbox.mapView;

        if (!theMap) {
          reject("No map has been loaded");
          return;
        }

        let bounds: MGLCoordinateBounds = {
          sw: CLLocationCoordinate2DMake(options.bounds.south, options.bounds.west),
          ne: CLLocationCoordinate2DMake(options.bounds.north, options.bounds.east)
        };

        let animated = options.animated === undefined || options.animated;

        let padding: UIEdgeInsets = {
          top: 25,
          left: 25,
          bottom: 25,
          right: 25
        };

        theMap.setVisibleCoordinateBoundsEdgePaddingAnimated(bounds, padding, animated);
        resolve();
      } catch (ex) {
        console.log("Error in mapbox.setViewport: " + ex);
        reject(ex);
      }
    });
  }

  downloadOfflineRegion(options: DownloadOfflineRegionOptions): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        let styleURL = _getMapStyle(options.style);
        let swCoordinate = CLLocationCoordinate2DMake(options.bounds.south, options.bounds.west);
        let neCoordinate = CLLocationCoordinate2DMake(options.bounds.north, options.bounds.east);

        let bounds: MGLCoordinateBounds = {
          sw: swCoordinate,
          ne: neCoordinate
        };

        let region = MGLTilePyramidOfflineRegion.alloc().initWithStyleURLBoundsFromZoomLevelToZoomLevel(
            styleURL,
            bounds,
            options.minZoom,
            options.maxZoom);

        if (options.accessToken) {
          MGLAccountManager.accessToken = options.accessToken;
        }

        // TODO there's more observers, see https://www.mapbox.com/ios-sdk/examples/offline-pack/
        if (options.onProgress) {
          _addObserver(MGLOfflinePackProgressChangedNotification, (notification: NSNotification) => {
            let offlinePack = notification.object;
            let offlinePackProgress = offlinePack.progress;
            let userInfo = NSKeyedUnarchiver.unarchiveObjectWithData(offlinePack.context);
            let complete = offlinePackProgress.countOfResourcesCompleted === offlinePackProgress.countOfResourcesExpected;

            options.onProgress({
              name: userInfo.objectForKey("name"),
              completed: offlinePackProgress.countOfResourcesCompleted,
              expected: offlinePackProgress.countOfResourcesExpected,
              percentage: Math.round((offlinePackProgress.countOfResourcesCompleted / offlinePackProgress.countOfResourcesExpected) * 10000) / 100,
              complete: complete
            });

            if (complete) {
              resolve();
            }
          });
        }

        _addObserver(MGLOfflinePackErrorNotification, (notification: NSNotification) => {
          let offlinePack = notification.object;
          let userInfo = NSKeyedUnarchiver.unarchiveObjectWithData(offlinePack.context);
          let error = notification.userInfo[MGLOfflinePackUserInfoKeyError];
          reject({
            name: userInfo.objectForKey("name"),
            error: "Download error. " + error
          });
        });

        _addObserver(MGLOfflinePackMaximumMapboxTilesReachedNotification, (notification: NSNotification) => {
          let offlinePack = notification.object;
          let userInfo = NSKeyedUnarchiver.unarchiveObjectWithData(offlinePack.context);
          let maximumCount = notification.userInfo[MGLOfflinePackUserInfoKeyMaximumCount];
          console.log(`Offline region '${userInfo.objectForKey("name")}' reached the tile limit of ${maximumCount}`);
        });

        // Store some data for identification purposes alongside the downloaded resources.
        let userInfo = {"name": options.name};
        let context = NSKeyedArchiver.archivedDataWithRootObject(userInfo);

        // Create and register an offline pack with the shared offline storage object.
        MGLOfflineStorage.sharedOfflineStorage.addPackForRegionWithContextCompletionHandler(region, context, (pack, error: NSError) => {
          if (error) {
            // The pack couldn’t be created for some reason.
            reject(error.localizedFailureReason);
          } else {
            // Start downloading.
            pack.resume();
          }
        });

      } catch (ex) {
        console.log("Error in mapbox.downloadOfflineRegion: " + ex);
        reject(ex);
      }
    });
  }

  listOfflineRegions(options?: ListOfflineRegionsOptions): Promise<OfflineRegion[]> {
    return new Promise((resolve, reject) => {
      try {
        let packs = MGLOfflineStorage.sharedOfflineStorage.packs;
        if (!packs) {
          reject("No packs found or Mapbox not ready yet");
          return;
        }

        let regions = [];
        for (let i = 0; i < packs.count; i++) {
          let pack: MGLOfflinePack = packs.objectAtIndex(i);
          let region: MGLTilePyramidOfflineRegion = <MGLTilePyramidOfflineRegion>pack.region;
          let userInfo = NSKeyedUnarchiver.unarchiveObjectWithData(pack.context);
          regions.push({
            name: userInfo.objectForKey("name"),
            style: "" + region.styleURL,
            minZoom: region.minimumZoomLevel,
            maxZoom: region.maximumZoomLevel,
            bounds: {
              north: region.bounds.ne.latitude,
              east: region.bounds.ne.longitude,
              south: region.bounds.sw.latitude,
              west: region.bounds.sw.longitude
            }
          });
        }
        resolve(regions);

      } catch (ex) {
        console.log("Error in mapbox.listOfflineRegions: " + ex);
        reject(ex);
      }
    });
  }

  deleteOfflineRegion(options: DeleteOfflineRegionOptions): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        if (!options || !options.name) {
          reject("Pass in the 'name' param");
          return;
        }

        let packs = MGLOfflineStorage.sharedOfflineStorage.packs;
        let found = false;
        for (let i = 0; i < packs.count; i++) {
          let pack = packs.objectAtIndex(i);
          let userInfo = NSKeyedUnarchiver.unarchiveObjectWithData(pack.context);
          let name = userInfo.objectForKey("name");
          if (name === options.name) {
            found = true;
            MGLOfflineStorage.sharedOfflineStorage.removePackWithCompletionHandler(pack, (error: NSError) => {
              if (error) {
                // The pack couldn’t be deleted for some reason.
                reject(error.localizedFailureReason);
              } else {
                resolve();
                // don't return, see note below
              }
            });
            // don't break the loop as there may be multiple packs with the same name
          }
        }
        if (!found) {
          reject("Region not found");
        }
      } catch (ex) {
        console.log("Error in mapbox.deleteOfflineRegion: " + ex);
        reject(ex);
      }
    });
  }

  addExtrusion(options: AddExtrusionOptions, nativeMap?): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        let theMap: MGLMapView = nativeMap || _mapbox.mapView;

        if (!theMap) {
          reject("No map has been loaded");
          return;
        }

        resolve();
      } catch (ex) {
        console.log("Error in mapbox.deleteOfflineRegion: " + ex);
        reject(ex);
      }
    });
  }

  addGeoJsonClustered(options: AddGeoJsonClusteredOptions, nativeMap?): Promise<any> {
    throw new Error('Method not implemented.');
  }
}

const _addObserver = (eventName, callback) => {
  return utils.ios.getter(NSNotificationCenter, NSNotificationCenter.defaultCenter).addObserverForNameObjectQueueUsingBlock(
      eventName, null, utils.ios.getter(NSOperationQueue, NSOperationQueue.mainQueue), callback);
};

const _downloadImage = (marker) => {
  return new Promise((resolve, reject) => {
    // to cache..
    if (_markerIconDownloadCache[marker.icon]) {
      marker.iconDownloaded = _markerIconDownloadCache[marker.icon];
      resolve(marker);
      return;
    }
    // ..or not to cache
    http.getImage(marker.icon).then(
        (output) => {
          marker.iconDownloaded = output.ios;
          _markerIconDownloadCache[marker.icon] = marker.iconDownloaded;
          resolve(marker);
        }, (ignoredError) => {
          console.log(`Download failed for ${marker.icon} with error: ${ignoredError}`);
          resolve(marker);
        });
  });
};

const _downloadMarkerImages = (markers) => {
  let iterations = [];
  let result = [];
  for (let i = 0; i < markers.length; i++) {
    let marker = markers[i];
    if (marker.icon && marker.icon.startsWith("http")) {
      let p = _downloadImage(marker).then((mark) => {
        result.push(mark);
      });
      iterations.push(p);
    } else {
      result.push(marker);
    }
  }

  return Promise.all(iterations).then((output) => {
    return result;
  });
};

const _addMarkers = (markers: MapboxMarker[], nativeMap?) => {
  if (!markers) {
    console.log("No markers passed");
    return;
  }
  if (!Array.isArray(markers)) {
    console.log("markers must be passed as an Array: [{title: 'foo'}]");
    return;
  }
  let theMap: MGLMapView = nativeMap || _mapbox.mapView;

  _downloadMarkerImages(markers).then((updatedMarkers: any) => {
    for (let m in updatedMarkers) {
      let marker = updatedMarkers[m];
      let lat = marker.lat;
      let lng = marker.lng;
      let point = MGLPointAnnotation.new();
      point.coordinate = CLLocationCoordinate2DMake(lat, lng);
      point.title = marker.title;
      point.subtitle = marker.subtitle;
      // needs to be done before adding to the map, otherwise the delegate method 'mapViewImageForAnnotation' can't use it
      _markers.push(marker);
      theMap.addAnnotation(point);

      if (marker.selected) {
        theMap.selectAnnotationAnimated(point, false);
      }

      marker.ios = point;
    }
  });
};

class MGLMapViewDelegateImpl extends NSObject implements MGLMapViewDelegate {
  public static ObjCProtocols = [MGLMapViewDelegate];

  static new(): MGLMapViewDelegateImpl {
    return <MGLMapViewDelegateImpl>super.new();
  }

  private mapLoadedCallback: (mapView: MGLMapView) => void;

  public initWithCallback(mapLoadedCallback: (mapView: MGLMapView) => void): MGLMapViewDelegateImpl {
    this.mapLoadedCallback = mapLoadedCallback;
    return this;
  }

  mapViewDidFinishLoadingMap(mapView: MGLMapView): void {
    if (this.mapLoadedCallback !== undefined) {
      this.mapLoadedCallback(mapView);
      // this should be fired only once, but it's also fired when the style changes, so just remove the callback
      this.mapLoadedCallback = undefined;
    }
  }

  mapViewAnnotationCanShowCallout(mapView: MGLMapView, annotation: MGLAnnotation): boolean {
    return true;
  }

  mapViewDidFailLoadingMapWithError(mapView: MGLMapView, error: NSError): void {
    console.log("mapViewDidFailLoadingMapWithError: " + error);
  }

  // fired when the marker icon is about to be rendered - return null for the default icon
  mapViewImageForAnnotation(mapView: MGLMapView, annotation: MGLAnnotation): MGLAnnotationImage {
    let cachedMarker = this.getTappedMarkerDetails(annotation);
    if (cachedMarker) {
      if (cachedMarker.reuseIdentifier) {
        let reusedImage = mapView.dequeueReusableAnnotationImageWithIdentifier(cachedMarker.reuseIdentifier);
        if (reusedImage) {
          return reusedImage;
        }
      }

      // TODO try adding .rotatesToMatchCamera = true;
      // .. for instance in the mapViewDidDeselectAnnotationView / mapViewDidSelectAnnotationView / mapViewViewForAnnotation delegate

      if (cachedMarker.icon) {
        if (cachedMarker.icon.startsWith("res://")) {
          let resourcename = cachedMarker.icon.substring("res://".length);
          let imageSource = imgSrc.fromResource(resourcename);
          if (imageSource === null) {
            console.log(`Unable to locate ${resourcename}`);
          } else {
            cachedMarker.reuseIdentifier = cachedMarker.icon;
            return MGLAnnotationImage.annotationImageWithImageReuseIdentifier(imageSource.ios, cachedMarker.reuseIdentifier);
          }
        } else if (cachedMarker.icon.startsWith("http")) {
          if (cachedMarker.iconDownloaded !== null) {
            cachedMarker.reuseIdentifier = cachedMarker.icon;
            return MGLAnnotationImage.annotationImageWithImageReuseIdentifier(cachedMarker.iconDownloaded, cachedMarker.reuseIdentifier);
          }
        } else {
          console.log("Please use res://resourcename, http(s)://imageurl or iconPath to use a local path");
        }
      } else if (cachedMarker.iconPath) {
        let appPath = fs.knownFolders.currentApp().path;
        let iconFullPath = appPath + "/" + cachedMarker.iconPath;
        if (fs.File.exists(iconFullPath)) {
          let image = imgSrc.fromFile(iconFullPath).ios;
          // perhaps add resize options for nice retina rendering (although you can now use the 'icon' param instead)
          cachedMarker.reuseIdentifier = cachedMarker.iconPath;
          return MGLAnnotationImage.annotationImageWithImageReuseIdentifier(image, cachedMarker.reuseIdentifier);
        }
      }
    }
    return null;
  }

  // fired when on of the callout's accessoryviews is tapped (not currently used)
  mapViewAnnotationCalloutAccessoryControlTapped(mapView: MGLMapView, annotation: MGLAnnotation, control: UIControl): void {
  }

  // fired when a marker is tapped
  mapViewDidSelectAnnotation(mapView: MGLMapView, annotation: MGLAnnotation): void {
    // console.log(">>>>> mapViewDidSelectAnnotation " + annotation.class() + " @ " + new Date().getTime());
    let cachedMarker = this.getTappedMarkerDetails(annotation);
    if (cachedMarker && cachedMarker.onTap) {
      cachedMarker.onTap(cachedMarker);
    }
  }

  // fired when a callout is tapped
  mapViewTapOnCalloutForAnnotation(mapView: MGLMapView, annotation: MGLAnnotation): void {
    let cachedMarker = this.getTappedMarkerDetails(annotation);
    if (cachedMarker && cachedMarker.onCalloutTap) {
      cachedMarker.onCalloutTap(cachedMarker);
    }
  }

  private getTappedMarkerDetails(tapped): any {
    for (let m in _markers) {
      let cached = _markers[m];
      // don't compare lat/lng types as they're not the same (same for (sub)title, they may be null vs undefined)
      // tslint:disable-next-line:triple-equals
      if (cached.lat == tapped.coordinate.latitude &&
          // tslint:disable-next-line:triple-equals
          cached.lng == tapped.coordinate.longitude &&
          // tslint:disable-next-line:triple-equals
          cached.title == tapped.title &&
          // tslint:disable-next-line:triple-equals
          cached.subtitle == tapped.subtitle) {
        return cached;
      }
    }
  }
}

class MapTapHandlerImpl extends NSObject {
  private _owner: WeakRef<Mapbox>;
  private _listener: (data: LatLng) => void;
  private _mapView: MGLMapView;

  public static initWithOwnerAndListenerForMap(owner: WeakRef<Mapbox>, listener: (data: LatLng) => void, mapView: MGLMapView): MapTapHandlerImpl {
    let handler = <MapTapHandlerImpl>MapTapHandlerImpl.new();
    handler._owner = owner;
    handler._listener = listener;
    handler._mapView = mapView;
    return handler;
  }

  public tap(recognizer: UITapGestureRecognizer): void {
    const tapPoint = recognizer.locationInView(this._mapView);

    const tapCoordinate = this._mapView.convertPointToCoordinateFromView(tapPoint, this._mapView);
    this._listener({
      lat: tapCoordinate.latitude,
      lng: tapCoordinate.longitude
    });
  }

  public static ObjCExposedMethods = {
    "tap": {returns: interop.types.void, params: [interop.types.id]}
  };
}

class MapPanHandlerImpl extends NSObject {
  private _owner: WeakRef<Mapbox>;
  private _listener: (data?: LatLng) => void;
  private _mapView: MGLMapView;

  public static initWithOwnerAndListenerForMap(owner: WeakRef<Mapbox>, listener: (data?: LatLng) => void, mapView: MGLMapView): MapPanHandlerImpl {
    let handler = <MapPanHandlerImpl>MapPanHandlerImpl.new();
    handler._owner = owner;
    handler._listener = listener;
    handler._mapView = mapView;
    return handler;
  }

  public pan(recognizer: UIPanGestureRecognizer): void {
    const panPoint = recognizer.locationInView(this._mapView);
    const panCoordinate = this._mapView.convertPointToCoordinateFromView(panPoint, this._mapView);
    this._listener({
      lat: panCoordinate.latitude,
      lng: panCoordinate.longitude
    });
  }

  public static ObjCExposedMethods = {
    "pan": {returns: interop.types.void, params: [interop.types.id]}
  };
}

class MapSwipeHandlerImpl extends NSObject {
  private _owner: WeakRef<Mapbox>;
  private _listener: (data?: LatLng) => void;
  private _mapView: MGLMapView;

  public static initWithOwnerAndListenerForMap(owner: WeakRef<Mapbox>, listener: (data?: LatLng) => void, mapView: MGLMapView): MapSwipeHandlerImpl {
    let handler = <MapSwipeHandlerImpl>MapSwipeHandlerImpl.new();
    handler._owner = owner;
    handler._listener = listener;
    handler._mapView = mapView;
    return handler;
  }

  public swipe(recognizer: UISwipeGestureRecognizer): void {
    const swipePoint = recognizer.locationInView(this._mapView);
    const swipeCoordinate = this._mapView.convertPointToCoordinateFromView(swipePoint, this._mapView);
    this._listener({
      lat: swipeCoordinate.latitude,
      lng: swipeCoordinate.longitude
    });
  }

  public static ObjCExposedMethods = {
    "swipe": {returns: interop.types.void, params: [interop.types.id]}
  };
}

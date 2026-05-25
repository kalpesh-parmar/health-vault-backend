import cv2
import numpy as np

def extract_graph_data(image_path):

    graph_data = []

    image = cv2.imread(image_path)

    if image is None:
        return graph_data

    height, width = image.shape[:2]

    gray = cv2.cvtColor(
        image,
        cv2.COLOR_BGR2GRAY
    )
    _, thresh = cv2.threshold(
        gray,
        150,
        255,
        cv2.THRESH_BINARY_INV
    )
    contours, _ = cv2.findContours(
        thresh,
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_SIMPLE
    )
    points=[]

    for contour in contours:

        area = cv2.contourArea(contour)

        if area < 100:
            continue

        for point in contour:

            x, y = point[0]

            points.append({
                "x": int(x),
                "y": int(height - y)
            })
        graph_data.append({
            "type": "graph",
            "coordinates": points,
            "width": width,
            "height": height
        })
    return graph_data